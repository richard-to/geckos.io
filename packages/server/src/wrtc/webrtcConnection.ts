import Connection from './connection'
import CreateDataChannel from '../geckos/channel'
import Channel from '../geckos/channel'
import { ChannelId, ServerOptions } from '@geckos.io/common/lib/types'

const MediaStream = require('wrtc').MediaStream
const DefaultRTCPeerConnection: RTCPeerConnection = require('wrtc').RTCPeerConnection

// strangely something it takes a long time
// so I set it to 10 seconds
const TIME_TO_HOST_CANDIDATES = 10000

export default class WebRTCConnection extends Connection {
  public peerConnection: RTCPeerConnection
  public channel: Channel
  public additionalCandidates: RTCIceCandidate[] = []
  private options: any

  // Save the client's audio/video tracks so we can forward them to other clients
  public audio: RTCRtpTransceiver
  public video: RTCRtpTransceiver

  // Keep a map of other client's audio/video tracks so that we can correctly match
  // them up on local clients
  public audioMap: Map<ChannelId, RTCRtpTransceiver> = new Map()
  public videoMap: Map<ChannelId, RTCRtpTransceiver> = new Map()


  constructor(id: ChannelId, serverOptions: ServerOptions, public connections: Map<any, any>, public userData: any) {
    super(id)

    const {
      enableAudio = false,
      enableVideo = false,
      iceServers = [],
      iceTransportPolicy = 'all',
      portRange,
      ...dataChannelOptions
    } = serverOptions

    this.options = {
      timeToHostCandidates: TIME_TO_HOST_CANDIDATES
    }

    let configuration: RTCConfiguration = {
      // @ts-ignore
      sdpSemantics: 'unified-plan',
      iceServers: iceServers,
      iceTransportPolicy: iceTransportPolicy
    }

    // @ts-ignore   // portRange is a nonstandard API
    if (portRange?.min && portRange?.max) configuration = { ...configuration, portRange }

    // @ts-ignore
    this.peerConnection = new DefaultRTCPeerConnection(configuration)

    this.setupStreams(enableVideo, enableVideo)

    this.peerConnection.onconnectionstatechange = () => {
      if (this.peerConnection.connectionState === 'disconnected') this.close()
    }

    this.channel = new CreateDataChannel(this, dataChannelOptions, userData)
  }

  /**
   * Setup audio/video streams
   *
   * The server is connected to multiple clients. The server will
   * forward audio/video streams to all connected clients.
   *
   * The server also needs to ensure that each client knows which
   * track belongs to which client.
   *
   * The track id cannot be used because that will not be the same on
   * on the server and client.
   *
   * The track's mid will be the same on the server and client, so we
   * will use that.
   *
   * The track's mid does not get generated when calling addTransceiver. This
   * is why we store the transceiver and not just the mid
   *
   * @param enableAudio Enables audio streams
   * @param enableVideo Enables video streams
   */
  setupStreams(enableAudio: boolean, enableVideo: boolean) {
    if (enableVideo) {
      if (!this.video) {
        // Video track that we will forward to other tracks
        this.video = this.peerConnection.addTransceiver('video')
      }

      this.connections.forEach((theirConnection) => {
        // Send my video to their client
        const theirVideo = theirConnection.peerConnection.addTransceiver('video')
        theirVideo.sender.replaceTrack(this.video.receiver.track)
        theirConnection.videoMap.set(this.id, theirVideo)
        // Send their video to my client
        const myVideo = this.peerConnection.addTransceiver('video')
        myVideo.sender.replaceTrack(theirConnection.video.receiver.track)
        if (myVideo.sender.track) {
          this.videoMap.set(theirConnection.id, myVideo)
        }
      })
    }

    if (enableAudio) {
      if (!this.audio) {
        // Audio track that we will forward to other tracks
        this.audio = this.peerConnection.addTransceiver('audio')
      }

      this.connections.forEach((theirConnection) => {
        // Send my audio to their client
        const theirAudio = theirConnection.peerConnection.addTransceiver('audio')
        theirAudio.sender.replaceTrack(this.audio.receiver.track)
        theirConnection.audioMap.set(this.id, theirAudio)

        // Send their audio to my client
        const myAudio = this.peerConnection.addTransceiver('audio')
        myAudio.sender.replaceTrack(theirConnection.audio.receiver.track)
        if (myAudio.sender.track) {
          this.audioMap.set(theirConnection.id, myAudio)
        }
      })
    }
  }

  async doOffer() {
    try {
      const offer: RTCSessionDescriptionInit = await this.peerConnection.createOffer()
      await this.peerConnection.setLocalDescription(offer)
      // we do not wait, since we request the missing candidates later
      /*await*/ this.waitUntilIceGatheringStateComplete(this.peerConnection, this.options)
    } catch (error) {
      console.error(error.messages)
      this.close()
      throw error
    }
  }

  /**
   * Reconnect renegotiates the WebRTC connection so we can retrieve updated video/audio tracks
   * as new clients join.
   *
   * Renegotiating a connection requires sending a new offer which should be done by the server
   * since the signal workflow uses HTTP requests and not WebSockets. This means that the server
   * wouldn't be able to send requests to the client. The client must send the HTTP requests.
   */
  async reconnect() {
    await this.doOffer()
  }


  get iceConnectionState() {
    return this.peerConnection.iceConnectionState
  }

  get localDescription() {
    return this.descriptionToJSON(this.peerConnection.localDescription) //, true)
  }

  get remoteDescription() {
    return this.descriptionToJSON(this.peerConnection.remoteDescription)
  }

  get signalingState() {
    return this.peerConnection.signalingState
  }

  async applyAnswer(answer: RTCSessionDescription) {
    await this.peerConnection.setRemoteDescription(answer)
  }

  toJSON = () => {
    return {
      ...super.toJSON(),
      iceConnectionState: this.iceConnectionState,
      localDescription: this.localDescription,
      remoteDescription: this.remoteDescription,
      signalingState: this.signalingState
    }
  }

  descriptionToJSON(description: RTCSessionDescription | null, shouldDisableTrickleIce = false) {
    return !description
      ? {}
      : {
          type: description.type,
          sdp: shouldDisableTrickleIce ? this.disableTrickleIce(description.sdp) : description.sdp
        }
  }

  disableTrickleIce(sdp: string) {
    return sdp.replace(/\r\na=ice-options:trickle/g, '')
  }

  close() {
    this.peerConnection.close()
    super.close()
  }

  async waitUntilIceGatheringStateComplete(peerConnection: RTCPeerConnection, options: any): Promise<void> {
    if (peerConnection.iceGatheringState === 'complete') {
      return
    }

    let totalIceCandidates = 0

    const { timeToHostCandidates } = options

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        peerConnection.removeEventListener('icecandidate', onIceCandidate)

        // if time is up but we found some iceCandidates
        if (totalIceCandidates > 0) {
          // console.log('Timed out waiting for all host candidates, will continue with what we have so far.')
          resolve()
        } else {
          reject(new Error('Timed out waiting for host candidates State: ' + peerConnection.iceGatheringState))
        }
      }, timeToHostCandidates)

      // peerConnection.addEventListener('icegatheringstatechange', _ev => {
      //   console.log('seconds', new Date().getSeconds(), peerConnection.iceGatheringState)
      // })

      const onIceCandidate = (ev: RTCPeerConnectionIceEvent) => {
        const { candidate } = ev

        totalIceCandidates++

        if (candidate) this.additionalCandidates.push(candidate)

        if (!candidate) {
          clearTimeout(timeout)
          peerConnection.removeEventListener('icecandidate', onIceCandidate)
          resolve()
        }
      }

      peerConnection.addEventListener('icecandidate', onIceCandidate)
    })
  }
}
