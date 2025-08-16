import { generatePKCE } from "@openauthjs/openauth/pkce";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_FILE_PATH = join(process.cwd(), "claude-code-tokens.json");

async function authorize() {
  const pkce = await generatePKCE();

  const url = new URL("https://claude.ai/oauth/authorize");
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "redirect_uri",
    "https://console.anthropic.com/oauth/code/callback"
  );
  url.searchParams.set(
    "scope",
    "org:create_api_key user:profile user:inference"
  );
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return {
    url: url.toString(),
    verifier: pkce.verifier,
  };
}

function storeTokens(refresh: string, access: string, expires: number) {
  const tokenData = {
    refresh,
    access,
    expires,
    updated_at: new Date().toISOString()
  };
  writeFileSync(TOKEN_FILE_PATH, JSON.stringify(tokenData, null, 2));
}


function getStoredTokens() {
  if (!existsSync(TOKEN_FILE_PATH)) {
    return null;
  }
  const data = readFileSync(TOKEN_FILE_PATH, 'utf-8');
  return JSON.parse(data);
}

async function exchange(code: string, verifier: string) {
  const splits = code.split("#");
  const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  });
  if (!result.ok)
    return {
      type: "failed" as const,
    };
  const json = await result.json();
  const tokenData = {
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
  
  storeTokens(tokenData.refresh, tokenData.access, tokenData.expires);
  
  return {
    type: "success" as const,
    message: "Tokens stored successfully"
  };
}

export { authorize, exchange, CLIENT_ID, getStoredTokens, storeTokens };