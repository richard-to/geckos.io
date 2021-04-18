import { Bridge } from '@geckos.io/common/lib/bridge'
import { EVENTS } from '@geckos.io/common/lib/constants'
import { RawMessage, Data, ChannelId, EventName } from '@geckos.io/common/lib/types'
import ParseMessage from '@geckos.io/common/lib/parseMessage'
import SendMessage from '@geckos.io/common/lib/sendMessage'

interface RTCRemotePeerConnection {
  id: ChannelId
  localDescription: RTCSessionDescriptionInit
}

export default class ConnectionsManagerClient {
  public maxMessageSize: number | undefined
  public localPeerConnection: RTCPeerConnection
  public remotePeerConnection: RTCRemotePeerConnection
  public dataChannel: RTCDataChannel
  public id: ChannelId
  public bridge = new Bridge()

  emit(eventName: EventName, data: Data | RawMessage | null = null) {
    SendMessage(this.dataChannel, this.maxMessageSize, eventName, data)
  }

  constructor(
    public url: string,
    public authorization: string | undefined,
    public label: string,
    public rtcConfiguration: RTCConfiguration,
    public stream: MediaStream | undefined,
  ) {}

  onTrack = (ev: RTCTrackEvent) => {
    // Forward ontrack event to listeners as AddTrack event
    this.bridge.emit(EVENTS.ADD_TRACK, ev)
  }

  onDataChannel = (ev: RTCDataChannelEvent) => {
    const { channel } = ev

    if (channel.label !== this.label) return

    this.dataChannel = channel

    // set default binaryType to arraybuffer
    // https://github.com/node-webrtc/node-webrtc/issues/441
    this.dataChannel.binaryType = 'arraybuffer'

    this.dataChannel.onmessage = (ev: MessageEvent) => {
      const { key, data } = ParseMessage(ev)
      this.bridge.emit(key, data)
    }
  }

  // fetch additional candidates
  async fetchAdditionalCandidates(host: string, id: ChannelId) {
    const res = await fetch(`${host}/connections/${id}/additional-candidates`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    if (res.ok) {
      const candidates = await res.json()
      candidates.forEach((c: RTCIceCandidateInit) => {
        this.localPeerConnection.addIceCandidate(c)
      })
    }
  }

  async connect() {
    const host = `${this.url}/.wrtc/v1`

    let headers: any = { 'Content-Type': 'application/json' }
    if (this.authorization) headers = { ...headers, ['Authorization']: this.authorization }
    let userData = {}

    try {
      const res = await fetch(`${host}/connections`, {
        method: 'POST',
        headers
      })

      const json = await res.json()

      userData = json.userData

      this.remotePeerConnection = json
    } catch (error) {
      console.error(error.message)
      return { error }
    }

    const { id, localDescription } = this.remotePeerConnection

    /**
     * testing
     */
    // console.log(localDescription.sdp?.split('\n'))
    // remove all host type candidates (for testing)
    // let removedHostCandidates: any[] = []
    // localDescription.sdp = localDescription.sdp
    //   ?.split('\n')
    //   .filter(line => {
    //     if (/typ host/.test(line)) {
    //       console.log('removing', line)
    //       removedHostCandidates.push(line.replace('a=', '').trim())
    //     }
    //     return !/typ host/.test(line)
    //   })
    //   .join('\n')
    // console.log(localDescription.sdp)
    // add all (host) candidates manually
    // setTimeout(() => {
    //   removedHostCandidates.forEach(candidate => {
    //     console.log('try to add candidate: ', candidate)
    //     this.localPeerConnection.addIceCandidate({ candidate, sdpMid: '0', sdpMLineIndex: 0 })
    //   })
    // }, 2000)

    const configuration: RTCConfiguration = {
      // @ts-ignore
      sdpSemantics: 'unified-plan',
      ...this.rtcConfiguration
    }

    const RTCPc =
      RTCPeerConnection ||
      webkitRTCPeerConnection ||
      // @ts-ignore
      mozRTCPeerConnection

    // create rtc peer connection
    this.localPeerConnection = new RTCPc(configuration)

    // get additional ice candidates
    // we do still continue to gather candidates even if the connection is established,
    // maybe we get a better connection.
    // So the server is still gathering candidates and we ask for them frequently.
    const showBackOffIntervals = (attempts = 10, initial = 50, factor = 1.8, jitter = 20) =>
      Array(attempts)
        .fill(0)
        .map(
          (_, index) => parseInt((initial * factor ** index).toString()) + parseInt((Math.random() * jitter).toString())
        )

    showBackOffIntervals().forEach(ms => {
      setTimeout(() => {
        this.fetchAdditionalCandidates(host, id)
      }, ms)
    })

    try {
      await this.localPeerConnection.setRemoteDescription(localDescription)
      this.localPeerConnection.addEventListener('track', this.onTrack)
      this.localPeerConnection.addEventListener('datachannel', this.onDataChannel, { once: true })

      // Only add audio/video tracks if stream has been provided
      if (this.stream) {
        this.stream.getTracks().forEach(track => (
          this.localPeerConnection.addTrack(track, this.stream as MediaStream))
        )
      }

      const originalAnswer = await this.localPeerConnection.createAnswer()
      const updatedAnswer = new RTCSessionDescription({
        type: 'answer',
        sdp: originalAnswer.sdp
      })

      await this.localPeerConnection.setLocalDescription(updatedAnswer)

      try {
        await fetch(`${host}/connections/${id}/remote-description`, {
          method: 'POST',
          body: JSON.stringify(this.localPeerConnection.localDescription),
          headers: {
            'Content-Type': 'application/json'
          }
        })
      } catch (error) {
        console.error(error.message)
        return { error }
      }

      const waitForDataChannel = (): Promise<void> => {
        return new Promise(resolve => {
          this.localPeerConnection.addEventListener(
            'datachannel',
            () => {
              resolve()
            },
            { once: true }
          )
        })
      }

      if (!this.dataChannel) await waitForDataChannel()

      return {
        userData,
        localPeerConnection: this.localPeerConnection,
        dataChannel: this.dataChannel,
        id: id,
      }
    } catch (error) {
      console.error(error.message)
      this.localPeerConnection.close()
      return { error }
    }
  }

  /**
   * Reconnect renegotiates the WebRTC connection so we can retrieve updated video/audio tracks
   * as new clients join.
   */
  async reconnect(id: ChannelId) {
    const host = `${this.url}/.wrtc/v1`

    let headers: any = { 'Content-Type': 'application/json' }
    if (this.authorization) {
      headers = {
        ...headers,
        ['Authorization']: this.authorization,
      }
    }

    try {
      const res = await fetch(`${host}/connections/${id}/reconnect`, {
        method: 'POST',
        headers,
      })

      const json = await res.json()

      this.remotePeerConnection = json
    } catch (error) {
      console.error(error.message)
      return { error }
    }

    const { localDescription } = this.remotePeerConnection

    // get additional ice candidates
    // we do still continue to gather candidates even if the connection is established,
    // maybe we get a better connection.
    // So the server is still gathering candidates and we ask for them frequently.
    const showBackOffIntervals = (attempts = 10, initial = 50, factor = 1.8, jitter = 20) =>
      Array(attempts)
        .fill(0)
        .map(
          (_, index) => parseInt((initial * factor ** index).toString()) + parseInt((Math.random() * jitter).toString())
        )

    showBackOffIntervals().forEach(ms => {
      setTimeout(() => {
        this.fetchAdditionalCandidates(host, id)
      }, ms)
    })

    try {
      await this.localPeerConnection.setRemoteDescription(localDescription)

      const originalAnswer = await this.localPeerConnection.createAnswer()
      const updatedAnswer = new RTCSessionDescription({
        type: 'answer',
        sdp: originalAnswer.sdp,
      })

      await this.localPeerConnection.setLocalDescription(updatedAnswer)

      try {
        await fetch(`${host}/connections/${id}/remote-description`, {
          method: 'POST',
          body: JSON.stringify(this.localPeerConnection.localDescription),
          headers: {
            'Content-Type': 'application/json',
          }
        })
      } catch (error) {
        console.error(error.message)
        return { error }
      }
    } catch (error) {
      console.error(error.message)
    }
  }
}
