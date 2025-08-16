import { Hono } from "hono"
import { cors } from "hono/cors"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { logger } from "hono/logger"
import { proxy } from "hono/proxy"
import { authorize, exchange, getStoredTokens, CLIENT_ID, storeTokens } from "./claude-code-auth"

const app = new Hono()

app.use(cors())

app.use(logger())

app.use(async (c, next) => {
  await next()
  c.res.headers.set("X-Accel-Buffering", "no")
})

app.get("/", (c) => c.text("A proxy for AI!"))

app.get("/claude-code/authorize", async (c) => {
  const authData = await authorize()
  return c.json(authData)
})

app.post(
  "/claude-code/exchange",
  zValidator(
    "json",
    z.object({
      code: z.string(),
      verifier: z.string(),
    }),
  ),
  async (c) => {
    const { code, verifier } = c.req.valid("json")
    const result = await exchange(code, verifier)
    return c.json(result)
  },
)

app.use("/claude-code/proxy/*", async (c) => {
  const auth = getStoredTokens()
  if (!auth) {
    return c.json({ error: "No authentication found. Please authorize first." }, 401)
  }
  
  // Check if token needs refresh
  if (!auth.access || auth.expires < Date.now()) {
    const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: auth.refresh,
        client_id: CLIENT_ID,
      }),
    })
    
    if (!response.ok) {
      return c.json({ error: "Failed to refresh token. Please re-authorize." }, 401)
    }
    
    const json = await response.json()
    const newTokenData = {
      refresh: json.refresh_token,
      access: json.access_token,
      expires: Date.now() + json.expires_in * 1000,
    }
    
    // Store refreshed tokens
    storeTokens(newTokenData.refresh, newTokenData.access, newTokenData.expires)
    auth.access = newTokenData.access
  }
  
  const url = new URL(c.req.url)
  const targetPath = url.pathname.replace("/claude-code/proxy", "")
  const targetUrl = `https://api.anthropic.com${targetPath}${url.search}`
  
  const headers = new Headers()
  c.req.raw.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (
      !k.startsWith("cf-") &&
      !k.startsWith("x-forwarded-") &&
      !k.startsWith("cdn-") &&
      k !== "x-real-ip" &&
      k !== "host"
    ) {
      headers.set(key, value)
    }
  })
  
  headers.set("authorization", `Bearer ${auth.access}`)
  headers.set("anthropic-beta", "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14")
  headers.delete("x-api-key")
  
  const res = await fetchWithTimeout(targetUrl, {
    method: c.req.method,
    headers,
    body: c.req.raw.body,
    timeout: 60000,
  })
  
  return new Response(res.body, {
    headers: res.headers,
    status: res.status,
  })
})

const fetchWithTimeout = async (
  url: string,
  { timeout, ...options }: RequestInit & { timeout: number },
) => {
  const controller = new AbortController()

  const timeoutId = setTimeout(() => {
    controller.abort()
  }, timeout)

  try {
    const res = await proxy(url, {
      ...options,
      signal: controller.signal,
      // @ts-expect-error
      duplex: "half",
    })
    clearTimeout(timeoutId)
    return res
  } catch (error) {
    clearTimeout(timeoutId)
    if (controller.signal.aborted) {
      return new Response("Request timeout", {
        status: 504,
      })
    }

    throw error
  }
}

const proxies: { pathSegment: string; target: string; orHostname?: string }[] =
  [
    {
      pathSegment: "generativelanguage",
      orHostname: "gooai.chatkit.app",
      target: "https://generativelanguage.googleapis.com",
    },
    {
      pathSegment: "groq",
      target: "https://api.groq.com",
    },
    {
      pathSegment: "anthropic",
      target: "https://api.anthropic.com",
    },
    {
      pathSegment: "pplx",
      target: "https://api.perplexity.ai",
    },
    {
      pathSegment: "openai",
      target: "https://api.openai.com",
    },
    {
      pathSegment: "mistral",
      target: "https://api.mistral.ai",
    },
    {
      pathSegment: "openrouter/api",
      target: "https://openrouter.ai/api",
    },
    {
      pathSegment: "openrouter",
      target: "https://openrouter.ai/api",
    },
    {
      pathSegment: "xai",
      target: "https://api.x.ai",
    },
    {
      pathSegment: "cerebras",
      target: "https://api.cerebras.ai",
    },
    {
      pathSegment: "googleapis-cloudcode-pa",
      target: "https://cloudcode-pa.googleapis.com",
    },
  ]

app.post(
  "/custom-model-proxy",
  zValidator(
    "query",
    z.object({
      url: z.string().url(),
    }),
  ),
  async (c) => {
    const { url } = c.req.valid("query")

    const res = await proxy(url, {
      method: c.req.method,
      body: c.req.raw.body,
      headers: c.req.raw.headers,
    })

    return new Response(res.body, {
      headers: res.headers,
      status: res.status,
    })
  },
)

app.use(async (c, next) => {
  const url = new URL(c.req.url)

  const proxy = proxies.find(
    (p) =>
      url.pathname.startsWith(`/${p.pathSegment}/`) ||
      (p.orHostname && url.hostname === p.orHostname),
  )

  if (proxy) {
    const headers = new Headers()
    headers.set("host", new URL(proxy.target).hostname)

    c.req.raw.headers.forEach((value, key) => {
      const k = key.toLowerCase()
      if (
        !k.startsWith("cf-") &&
        !k.startsWith("x-forwarded-") &&
        !k.startsWith("cdn-") &&
        k !== "x-real-ip" &&
        k !== "host"
      ) {
        headers.set(key, value)
      }
    })

    const targetUrl = `${proxy.target}${url.pathname.replace(
      `/${proxy.pathSegment}/`,
      "/",
    )}${url.search}`

    const res = await fetchWithTimeout(targetUrl, {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
      timeout: 60000,
    })

    return new Response(res.body, {
      headers: res.headers,
      status: res.status,
    })
  }

  next()
})

export default app
