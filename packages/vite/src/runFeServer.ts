// TODO (STREAMING) Move this to a new package called @redwoodjs/fe-server (goes
// well in naming with @redwoodjs/api-server)
// Only things used during dev can be in @redwoodjs/vite. Everything else has
// to go in fe-server
// UPDATE: We decided to name the package @redwoodjs/web-server instead of
// fe-server. And it's already created, but this hasn't been moved over yet.

import path from 'node:path'
import url from 'node:url'

import { createServerAdapter } from '@whatwg-node/server'
// @ts-expect-error We will remove dotenv-defaults from this package anyway
import { config as loadDotEnv } from 'dotenv-defaults'
import express from 'express'
import type { HTTPMethod } from 'find-my-way'
import { createProxyMiddleware } from 'http-proxy-middleware'
import type { Manifest as ViteBuildManifest } from 'vite'

import { getConfig, getPaths } from '@redwoodjs/project-config'

import { registerFwGlobalsAndShims } from './lib/registerFwGlobalsAndShims.js'
import { invoke } from './middleware/invokeMiddleware.js'
import { createMiddlewareRouter } from './middleware/register.js'
import type { Middleware } from './middleware/types.js'
import { getRscStylesheetLinkGenerator } from './rsc/rscCss.js'
import { createRscRequestHandler } from './rsc/rscRequestHandler.js'
import { setClientEntries } from './rsc/rscWorkerCommunication.js'
import { createPerRequestMap, createServerStorage } from './serverStore.js'
import { createReactStreamingHandler } from './streaming/createReactStreamingHandler.js'
import type { RWRouteManifest } from './types.js'
import { convertExpressHeaders } from './utils.js'

/**
 * TODO (STREAMING)
 * We have this server in the vite package only temporarily.
 * We will need to decide where to put it, so that rwjs/internal and other heavy dependencies
 * can be removed from the final docker image
 */

// --- @MARK This should be removed once we have re-architected the rw serve command ---
// We need the dotenv, so that prisma knows the DATABASE env var
// Normally the RW cli loads this for us, but we expect this file to be run directly
// without using the CLI. Remember to remove dotenv-defaults dependency from this package
loadDotEnv({
  path: path.join(getPaths().base, '.env'),
  defaults: path.join(getPaths().base, '.env.defaults'),
  multiline: true,
})
// ------------------------------------------------

export async function runFeServer() {
  const app = express()
  const rwPaths = getPaths()
  const rwConfig = getConfig()
  const rscEnabled = rwConfig.experimental?.rsc?.enabled

  registerFwGlobalsAndShims()

  if (rscEnabled) {
    try {
      // This will fail if we're not running in RSC mode (i.e. for Streaming SSR)
      await setClientEntries()
    } catch (e) {
      console.error('Failed to load client entries')
      console.error(e)
      process.exit(1)
    }
  }

  const routeManifestUrl = url.pathToFileURL(rwPaths.web.routeManifest).href
  const routeManifest: RWRouteManifest = (
    await import(routeManifestUrl, { with: { type: 'json' } })
  ).default

  const clientBuildManifestUrl = url.pathToFileURL(
    path.join(rwPaths.web.distClient, 'client-build-manifest.json'),
  ).href
  const clientBuildManifest: ViteBuildManifest = (
    await import(clientBuildManifestUrl, { with: { type: 'json' } })
  ).default

  // @MARK: Surely there's a better way than this!
  const clientEntry = Object.values(clientBuildManifest).find(
    (manifestItem) => {
      // For RSC builds, we pass in many Vite entries, so we need to find it differently.
      return rscEnabled
        ? manifestItem.file.includes('rwjs-client-entry-')
        : manifestItem.isEntry
    },
  )

  // @MARK: In prod, we create it once up front!
  const middlewareRouter = await createMiddlewareRouter()
  const serverStorage = createServerStorage()

  const handleWithMiddleware = () => {
    return createServerAdapter(async (req: Request) => {
      const matchedMw = middlewareRouter.find(req.method as HTTPMethod, req.url)

      const handler = matchedMw?.handler as Middleware | undefined

      if (!matchedMw) {
        return new Response('No middleware found', { status: 404 })
      }

      const [mwRes] = await invoke(req, handler, {
        params: matchedMw?.params,
      })

      return mwRes.toResponse()
    })
  }

  if (!clientEntry) {
    throw new Error('Could not find client entry in build manifest')
  }

  // 1. Use static handler for assets
  // For CF workers, we'd need an equivalent of this
  app.use(
    '/assets',
    express.static(rwPaths.web.distClient + '/assets', { index: false }),
  )

  app.use('*', (req, _res, next) => {
    // Convert express headers to fetch headers
    const perReqStore = createPerRequestMap({
      headers: convertExpressHeaders(req.headersDistinct),
    })

    // By wrapping next, we ensure that all of the other handlers will use this same perReqStore
    // But note that the serverStorage is RE-initialised for the RSC worker
    serverStorage.run(perReqStore, next)
  })

  // 2. Proxy the api server
  // TODO (STREAMING) we need to be able to specify whether proxying is required or not
  // e.g. deploying to Netlify, we don't need to proxy but configure it in Netlify
  // Also be careful of differences between v2 and v3 of the server
  app.use(
    rwConfig.web.apiUrl,
    // @WARN! Be careful, between v2 and v3 of http-proxy-middleware
    // the syntax has changed https://github.com/chimurai/http-proxy-middleware
    createProxyMiddleware({
      changeOrigin: false,
      pathRewrite: {
        [`^${rwConfig.web.apiUrl}`]: '', // remove base path
      },
      // Using 127.0.0.1 to force ipv4. With `localhost` you don't really know
      // if it's going to be ipv4 or ipv6
      target: `http://127.0.0.1:${rwConfig.api.port}`,
    }),
  )

  // Mounting middleware at /rw-rsc will strip /rw-rsc from req.url
  app.use(
    '/rw-rsc',
    createRscRequestHandler({
      getMiddlewareRouter: async () => middlewareRouter,
    }),
  )

  // Static asset handling MUST be defined before our catch all routing handler below
  // otherwise it will catch all requests for static assets and return a 404.
  // Placing this here defines our precedence for static asset handling - that we favor
  // the static assets over any application routing.
  app.use(express.static(rwPaths.web.distClient, { index: false }))

  const clientEntryPath = '/' + clientEntry.file

  const getStylesheetLinks = rscEnabled
    ? getRscStylesheetLinkGenerator(clientEntry.css)
    : () => clientEntry.css || []

  const routeHandler = await createReactStreamingHandler({
    routes: Object.values(routeManifest),
    clientEntryPath,
    getStylesheetLinks,
    getMiddlewareRouter: async () => middlewareRouter,
  })

  // Wrap with whatwg/server adapter. Express handler -> Fetch API handler
  app.get('*', createServerAdapter(routeHandler))

  app.post('*', handleWithMiddleware())

  app.listen(rwConfig.web.port)
  console.log(
    `Started production FE server on http://localhost:${rwConfig.web.port}`,
  )
}

runFeServer()
