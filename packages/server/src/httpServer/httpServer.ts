import url from 'url'
import http from 'http'
import ConnectionsManagerServer from '../wrtc/connectionsManager'
import SetCORS from './setCors'
import ParseBody from './parseBody'
import { CorsOptions } from '@geckos.io/common/lib/types'

const end = (res: http.ServerResponse, statusCode: number) => {
  res.writeHead(statusCode)
  res.end()
}

const HttpServer = (server: http.Server, connectionsManager: ConnectionsManagerServer, cors: CorsOptions) => {
  const prefix = '.wrtc'
  const version = 'v1'
  const root = `/${prefix}/${version}`
  const rootRegEx = new RegExp(`/${prefix}/${version}`)

  const evs = server.listeners('request').slice(0)
  server.removeAllListeners('request')

  server.on('request', async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const pathname = req.url ? url.parse(req.url, true).pathname : undefined
    const headers = req.headers
    const method = req.method

    // if the request is not part of the rootRegEx,
    // trigger the other server's (Express) events.
    if (!pathname || !rootRegEx.test(pathname)) {
      for (var i = 0; i < evs.length; i++) {
        evs[i].call(server, req, res)
      }
    }

    if (pathname && rootRegEx.test(pathname)) {
      const path1 = pathname === `${root}/connections`
      const path2 = new RegExp(`${prefix}\/${version}\/connections\/[0-9a-zA-Z]+\/remote-description`).test(pathname)
      const path3 = new RegExp(`${prefix}\/${version}\/connections\/[0-9a-zA-Z]+\/additional-candidates`).test(pathname)
      const closePath = new RegExp(`${prefix}\/${version}\/connections\/[0-9a-zA-Z]+\/close`).test(pathname)

      // Endpoint for renegotiating a WebRTC connection so we can retrieve updated video/audio tracks
      // as new clients join. We need to hit this endpoint since we want the server to send the initial
      // offer.
      const reconnectPath = new RegExp(`${prefix}\/${version}\/connections\/[0-9a-zA-Z]+\/reconnect`).test(pathname)

      // Endpoint for retrieving a map of audio/video streams by client connection ID
      //
      // This map is necessary since the server is forwarding audio/video from connected clients to the local
      // client. This means that we need a way to distinguish which audio/video streams belong to which client.
      //
      // This can be done using the track's mid which we can map to the channel's ID
      const streamsPath = new RegExp(`${prefix}\/${version}\/connections\/[0-9a-zA-Z]+\/streams`).test(pathname)

      SetCORS(req, res, cors)

      if (req.method === 'OPTIONS') {
        end(res, 200)
        return
      }

      let body = ''

      try {
        body = (await ParseBody(req)) as string
      } catch (error) {
        end(res, 400)
        return
      }

      res.on('error', _error => {
        end(res, 500)
        return
      })

      res.setHeader('Content-Type', 'application/json')

      if (pathname && method) {
        if (method === 'POST' && path1) {
          try {
            // create connection (and check auth header)
            const { status, connection, userData } = await connectionsManager.createConnection(
              headers?.authorization,
              req,
              res
            )

            // on http status code
            if (status !== 200) {
              if (status >= 100 && status < 600) end(res, status)
              else end(res, 500)
              return
            }

            if (!connection || !connection.id) {
              end(res, 500)
              return
            }

            const {
              id,
              iceConnectionState,
              peerConnection,
              remoteDescription,
              localDescription,
              signalingState
            } = connection

            res.write(
              JSON.stringify({
                userData, // the userData for authentication
                id,
                iceConnectionState,
                peerConnection,
                remoteDescription,
                localDescription,
                signalingState
              })
            )

            res.end()
            return
          } catch (error) {
            end(res, 500)
            return
          }
        } else if (method === 'POST' && path2) {
          const ids = pathname.match(/[0-9a-zA-Z]{24}/g)
          if (ids && ids.length === 1) {
            const id = ids[0]
            const connection = connectionsManager.getConnection(id)

            if (!connection) {
              end(res, 404)
              return
            }

            try {
              await connection.applyAnswer(JSON.parse(body))
              let connectionJSON = connection.toJSON()
              res.write(JSON.stringify(connectionJSON.remoteDescription))
              res.end()
              return
            } catch (error) {
              end(res, 400)
              return
            }
          } else {
            end(res, 400)
            return
          }
        } else if (method === 'GET' && path3) {
          const ids = pathname.match(/[0-9a-zA-Z]{24}/g)
          if (ids && ids.length === 1) {
            const id = ids[0]
            const connection = connectionsManager.getConnection(id)

            if (!connection) {
              end(res, 404)
              return
            }

            try {
              const additionalCandidates = [...connection.additionalCandidates]
              connection.additionalCandidates = []
              res.write(JSON.stringify(additionalCandidates))
              res.end()
              return
            } catch (error) {
              end(res, 400)
              return
            }
          } else {
            end(res, 400)
            return
          }
        } else if (method === 'POST' && closePath) {
          const ids = pathname.match(/[0-9a-zA-Z]{24}/g)
          if (ids && ids.length === 1) {
            const id = ids[0]
            const connection = connectionsManager.getConnection(id)
            connection?.close()
          } else {
            end(res, 400)
            return
          }
        } else if (method === 'POST' && reconnectPath) {
          const ids = pathname.match(/[0-9a-zA-Z]{24}/g)
          if (ids && ids.length === 1) {
            const id = ids[0]
            const connection = connectionsManager.getConnection(id)

            if (!connection) {
              end(res, 404)
              return
            }

            try {
              await connection.reconnect()
              let connectionJSON = connection.toJSON()
              res.write(JSON.stringify(connectionJSON))
              res.end()
              return
            } catch (error) {
              console.error(error.message)
              end(res, 400)
              return
            }
          } else {
            end(res, 400)
            return
          }
        } else if (method === 'POST' && streamsPath) {
          const ids = pathname.match(/[0-9a-zA-Z]{24}/g)
          if (ids && ids.length === 1) {
            const id = ids[0]
            const myConnection = connectionsManager.getConnection(id)

            if (!myConnection) {
              end(res, 404)
              return
            }

            try {
              const videoMap = new Map()
              const audioMap = new Map()

              myConnection.videoMap.forEach((transceiver, channelId) => {
                videoMap.set(transceiver.mid, channelId)
              })

              myConnection.audioMap.forEach((transceiver, channelId) => {
                audioMap.set(transceiver.mid, channelId)
              })

              res.write(JSON.stringify({
                audio: Object.fromEntries(audioMap),
                video: Object.fromEntries(videoMap),
              }))
              res.end()
            } catch (error) {
              console.error(error.message)
              end(res, 400)
              return
            }
          } else {
            end(res, 400)
            return
          }

        } else {
          end(res, 404)
          return
        }
      }
    }
  })
}

export default HttpServer
