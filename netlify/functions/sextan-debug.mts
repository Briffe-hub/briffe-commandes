/**
 * Netlify Function : sextan-debug
 */

import type { Config } from "@netlify/functions";

const BASE = Netlify.env.get("SEXTAN_BASE") ?? "https://briffe.sextan.catering";
const USER = Netlify.env.get("SEXTAN_USER") ?? "";
const PASS = Netlify.env.get("SEXTAN_PASS") ?? "";

export default async (req: Request): Promise<Response> => {
  const debug: Record<string, unknown>[] = [];

  const attempts = [
    { url: `${BASE}/api/auth/login`,  body: { username: USER, password: PASS } },
    { url: `${BASE}/api/login`,       body: { username: USER, password: PASS } },
    { url: `${BASE}/api/auth/login`,  body: { login: USER,    password: PASS } },
    { url: `${BASE}/api/users/login`, body: { username: USER, password: PASS } },
    { url: `${BASE}/api/auth`,        body: { username: USER, password: PASS } },
  ];

  for (const { url, body } of attempts) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const status = resp.status;
      let responseBody: unknown;
      try { responseBody = await resp.json(); }
      catch { responseBody = await resp.text(); }
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      debug.push({ url, status, responseBody, headers });
    } catch (e) {
      debug.push({ url, error: String(e) });
    }
  }

  return Response.json({ debug, user: USER, base: BASE });
};

export const config: Config = {
  path: "/api/sextan-debug",
};
