import type { IncomingMessage, OutgoingMessage } from 'http'

const ArrayBufferView = Object.getPrototypeOf(Object.getPrototypeOf(new Uint8Array())).constructor
export { ArrayBufferView }

export type USVString = string
export type ChannelId = string | undefined
export type EventName = string
export type RoomId = ChannelId
export type Data = string | number | Object
export type Payload = { [eventName: string]: Data }
export type RawMessage = USVString | ArrayBuffer | ArrayBufferView

export interface ServerOptions {
  enableAudio?: boolean
  enableVideo?: boolean
  iceServers?: RTCIceServer[]
  iceTransportPolicy?: RTCIceTransportPolicy
  label?: string
  ordered?: boolean
  maxRetransmits?: number
  maxPacketLifeTime?: number
  cors?: CorsOptions
  autoManageBuffering?: boolean
  /** Set a custom port range for the WebRTC connection. */
  portRange?: {
    /** Minimum port range (defaults to 0) */
    min: number
    /** Minimum port range (defaults to 65535) */
    max: number
  }
  /**
   * A async function to authenticate and authorize a user.
   * @param auth The authentication token
   * @param request The incoming http request
   * @param response The outgoing http response
   */
  authorization?: (
    auth: string | undefined,
    request: IncomingMessage,
    response: OutgoingMessage
  ) => Promise<boolean | any>
}

export interface ClientOptions {
  iceServers?: RTCIceServer[]
  iceTransportPolicy?: RTCIceTransportPolicy
  url?: string
  authorization?: string | undefined
  port?: number
  label?: string
  stream?: MediaStream | undefined
}

export interface EmitOptions {
  reliable?: boolean
  interval?: number
  runs?: number
}

type CorsOptionsOriginFunction = (req: IncomingMessage) => string
export interface CorsOptions {
  origin: string | CorsOptionsOriginFunction
  allowAuthorization?: boolean
}

export interface EventCallbackClient {
  (data: Data): void
}

export interface EventCallbackServer {
  (data: Data, senderId?: ChannelId): void
}

export interface EventCallbackRawMessage {
  (rawMessage: RawMessage): void
}

export interface ConnectionEventCallbackClient {
  (error?: Error): void
}

export interface DisconnectEventCallbackServer {
  (connectionState: 'disconnected' | 'failed' | 'closed'): void
}

export interface EventOptions {
  roomId?: RoomId
  senderId?: ChannelId
  id?: ChannelId
}
