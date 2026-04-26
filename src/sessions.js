/**
 * SessionManager — управление WhatsApp сессиями через Baileys.
 *
 * Каждая сессия = один номер телефона = одна директория с creds.
 * Статусы: STOPPED → STARTING → SCAN_QR_CODE → WORKING (+ FAILED = авто/ручной рекавери).
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import axios from 'axios'
import pino from 'pino'
import path from 'path'
import fs from 'fs'

// Директория для хранения creds (монтируется как Docker volume)
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions'

// Тихий логгер — Baileys очень многословен на DEBUG
const baileysLogger = pino({ level: 'silent' })

// Логгер для нашего кода
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino/file', options: { destination: 1 } },
})


// ── Вспомогательные утилиты ────────────────────────────────────────────────────

/**
 * Извлечь текст из Baileys message object.
 * WhatsApp хранит контент в разных полях в зависимости от типа.
 */
function extractText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
    ''
  )
}

/**
 * Отправить webhook на бэкенд — имитирует формат WAHA payload.
 * parse_waha_message() в бэкенде ожидает именно этот формат.
 */
async function sendWebhook(webhookUrl, session, waMessage) {
  try {
    const key = waMessage.key
    const msg = waMessage.message
    const text = extractText(msg)

    if (!text) return   // пустое тело — пропускаем

    const payload = {
      event: 'message',
      session,
      payload: {
        from: key.remoteJid,
        fromMe: key.fromMe,
        hasMedia: false,   // media поддержим позже
        body: text,
        pushName: waMessage.pushName || '',
        _data: {
          notifyName: waMessage.pushName || '',
          key: {
            remoteJid: key.remoteJid,
            fromMe: key.fromMe,
            id: key.id,
            // remoteJidAlt — для @lid аккаунтов (newer WA accounts)
            remoteJidAlt: waMessage.verifiedBizName || '',
          },
        },
      },
    }

    await axios.post(webhookUrl, payload, { timeout: 10_000 })
    logger.info({ session, from: key.remoteJid }, '[WA] Webhook sent')
  } catch (err) {
    logger.error({ session, err: err.message }, '[WA] Webhook delivery failed')
  }
}


// ── Session state ──────────────────────────────────────────────────────────────

class Session {
  constructor(slug) {
    this.slug = slug
    this.status = 'STOPPED'   // STOPPED | STARTING | SCAN_QR_CODE | WORKING | FAILED
    this.socket = null
    this.qrBase64 = null      // актуальный QR как base64 PNG
    this.me = null            // { id, name } когда WORKING
    this.webhookUrl = null    // куда слать входящие
    this.reconnectTimer = null
    this.reconnectAttempts = 0
  }
}


// ── SessionManager ────────────────────────────────────────────────────────────

export class SessionManager {
  constructor() {
    /** @type {Map<string, Session>} */
    this.sessions = new Map()
  }

  // ── Публичный API (вызывается из routes) ─────────────────────────────────

  /**
   * Запустить сессию.
   * Если сессия уже существует — просто проверяем webhookUrl и возвращаем статус.
   * Если нет — создаём сокет и начинаем подключение.
   */
  async start(slug, webhookUrl) {
    let session = this.sessions.get(slug)

    if (!session) {
      session = new Session(slug)
      this.sessions.set(slug, session)
    }

    // Обновляем webhook если изменился
    if (webhookUrl) {
      session.webhookUrl = webhookUrl
    }

    if (['WORKING', 'SCAN_QR_CODE', 'STARTING'].includes(session.status)) {
      // Уже запускается или работает
      return this._statusResponse(session)
    }

    session.status = 'STARTING'
    session.reconnectAttempts = 0

    // Запускаем асинхронно — не блокируем HTTP ответ
    this._createSocket(session).catch((err) => {
      logger.error({ slug, err: err.message }, '[WA] Failed to create socket')
      session.status = 'FAILED'
    })

    return this._statusResponse(session)
  }

  /**
   * Остановить сессию (logout из WhatsApp, удалить creds).
   */
  async stop(slug) {
    const session = this.sessions.get(slug)
    if (!session) return

    this._clearReconnect(session)

    if (session.socket) {
      try {
        await session.socket.logout()
      } catch (_) {
        // Если уже отключён — игнорируем
      }
      try {
        session.socket.end()
      } catch (_) {}
      session.socket = null
    }

    // Удаляем сохранённые creds → следующий start покажет QR заново
    const credsDir = path.join(SESSIONS_DIR, slug)
    if (fs.existsSync(credsDir)) {
      fs.rmSync(credsDir, { recursive: true, force: true })
    }

    session.status = 'STOPPED'
    session.qrBase64 = null
    session.me = null

    logger.info({ slug }, '[WA] Session stopped and creds deleted')
  }

  /**
   * Logout без удаления сессии из памяти — используется при FAILED для рекавери.
   * После logout нужно вызвать start() → появится новый QR.
   */
  async logout(slug) {
    const session = this.sessions.get(slug)
    if (!session) return

    this._clearReconnect(session)

    if (session.socket) {
      try { await session.socket.logout() } catch (_) {}
      try { session.socket.end() } catch (_) {}
      session.socket = null
    }

    // Удаляем creds → start() покажет свежий QR
    const credsDir = path.join(SESSIONS_DIR, slug)
    if (fs.existsSync(credsDir)) {
      fs.rmSync(credsDir, { recursive: true, force: true })
    }

    session.status = 'STOPPED'
    session.qrBase64 = null
    session.me = null

    logger.info({ slug }, '[WA] Session logged out (creds cleared)')
  }

  /** Текущий статус сессии. */
  status(slug) {
    const session = this.sessions.get(slug)
    if (!session) return { name: slug, status: 'STOPPED', me: null }
    return this._statusResponse(session)
  }

  /** QR как base64 PNG. null если не в SCAN_QR_CODE. */
  qr(slug) {
    return this.sessions.get(slug)?.qrBase64 ?? null
  }

  /**
   * Отправить текстовое сообщение.
   * chatId — "77771234567@c.us" или "169578311217371@lid"
   */
  async sendMessage(slug, chatId, text) {
    const session = this.sessions.get(slug)
    if (!session || session.status !== 'WORKING') {
      throw new Error(`Session '${slug}' is not WORKING (status: ${session?.status ?? 'STOPPED'})`)
    }
    await session.socket.sendMessage(chatId, { text })
    logger.info({ slug, chatId }, '[WA] Message sent')
  }

  /** Список всех сессий (для /api/sessions). */
  listSessions() {
    return [...this.sessions.values()].map((s) => this._statusResponse(s))
  }


  // ── Приватные методы ──────────────────────────────────────────────────────

  _statusResponse(session) {
    return {
      name: session.slug,
      status: session.status,
      me: session.me,
    }
  }

  _clearReconnect(session) {
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer)
      session.reconnectTimer = null
    }
  }

  /**
   * Создаёт Baileys WebSocket и вешает все event-листенеры.
   * Вызывается при старте и при каждом авто-реконнекте.
   */
  async _createSocket(session) {
    const { slug } = session
    const credsDir = path.join(SESSIONS_DIR, slug)

    // Baileys сохраняет ключи в файлы (creds.json + signal store)
    const { state, saveCreds } = await useMultiFileAuthState(credsDir)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        // Кэшируем SignalKeyStore для производительности
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,   // не спамим в консоль
      logger: baileysLogger,
      // Отключаем ненужные фичи → меньше трафика и RAM
      syncFullHistory: false,
      markOnlineOnConnect: false,
      fireInitQueries: false,
      emitOwnEvents: false,
      shouldIgnoreJid: (jid) => jid?.endsWith('@broadcast'),
    })

    session.socket = sock

    // Сохраняем creds при каждом обновлении (ротация ключей WA)
    sock.ev.on('creds.update', saveCreds)

    // ── Connection state machine ──────────────────────────────────────────

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      // Новый QR — конвертируем строку в base64 PNG
      if (qr) {
        try {
          session.qrBase64 = await QRCode.toDataURL(qr)
          session.status = 'SCAN_QR_CODE'
          logger.info({ slug }, '[WA] QR updated')
        } catch (err) {
          logger.error({ slug, err: err.message }, '[WA] QR generation failed')
        }
      }

      if (connection === 'open') {
        session.status = 'WORKING'
        session.qrBase64 = null
        session.me = {
          id: sock.user?.id ?? null,
          name: sock.user?.name ?? null,
        }
        session.reconnectAttempts = 0
        logger.info({ slug, me: session.me }, '[WA] Connected!')
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : null

        const loggedOut = statusCode === DisconnectReason.loggedOut

        logger.warn({ slug, statusCode, loggedOut }, '[WA] Connection closed')

        session.socket = null
        session.qrBase64 = null
        session.me = null

        if (loggedOut) {
          // Явный logout (пользователь сам вышел из WhatsApp)
          // → не переподключаемся, очищаем creds
          session.status = 'FAILED'
          try {
            fs.rmSync(credsDir, { recursive: true, force: true })
          } catch (_) {}
          logger.warn({ slug }, '[WA] Logged out — session marked FAILED, creds cleared')
        } else {
          // Временный сбой сети / рестарт WA → авто-реконнект с backoff
          session.status = 'STARTING'
          const delay = Math.min(5000 * (session.reconnectAttempts + 1), 60_000)
          session.reconnectAttempts += 1
          logger.info({ slug, delay, attempt: session.reconnectAttempts }, '[WA] Reconnecting...')

          session.reconnectTimer = setTimeout(async () => {
            try {
              await this._createSocket(session)
            } catch (err) {
              logger.error({ slug, err: err.message }, '[WA] Reconnect failed')
              session.status = 'FAILED'
            }
          }, delay)
        }
      }
    })

    // ── Входящие сообщения → webhook ──────────────────────────────────────

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // type 'notify' = реальные входящие, 'append' = история
      if (type !== 'notify') return

      const webhookUrl = session.webhookUrl
      if (!webhookUrl) return

      for (const msg of messages) {
        // Игнорируем свои сообщения и групповые чаты
        if (msg.key.fromMe) continue
        if (msg.key.remoteJid?.endsWith('@g.us')) continue
        if (msg.key.remoteJid?.endsWith('@broadcast')) continue

        const text = extractText(msg.message)
        if (!text) continue   // медиа, стикеры, etc — пропускаем

        await sendWebhook(webhookUrl, slug, msg)
      }
    })

    logger.info({ slug, version }, '[WA] Socket created')
  }
}
