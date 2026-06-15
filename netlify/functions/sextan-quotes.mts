/**
 * Netlify Function : sextan-quotes
 * Proxy authentifié vers l'API Sextan
 */

import type { Config } from "@netlify/functions";

const BASE = Netlify.env.get("SEXTAN_BASE") ?? "https://briffe.sextan.catering";
const USER = Netlify.env.get("SEXTAN_USER") ?? "";
const PASS = Netlify.env.get("SEXTAN_PASS") ?? "";

async function getSextanToken(): Promise<string> {
  const endpoints = [
    { url: `${BASE}/api/auth/login`,  body: { username: USER, password: PASS } },
    { url: `${BASE}/api/login`,       body: { username: USER, password: PASS } },
    { url: `${BASE}/api/auth/login`,  body: { login: USER,    password: PASS } },
    { url: `${BASE}/api/users/login`, body: { username: USER, password: PASS } },
  ];
  for (const { url, body } of endpoints) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) continue;
      const json = await resp.json() as Record<string, unknown>;
      const token =
        (json.token as string) ||
        (json.access_token as string) ||
        ((json.data as Record<string, unknown>)?.token as string) ||
        ((json.data as Record<string, unknown>)?.access_token as string) ||
        null;
      if (token) return token;
      const cookie = resp.headers.get("set-cookie");
      if (cookie) return `COOKIE:${cookie}`;
    } catch (e) {
      console.log(`[sextan-quotes] ${url} failed:`, e);
    }
  }
  throw new Error("Impossible de s'authentifier sur Sextan.");
}

async function fetchQuotes(token: string, from: string, to: string, offset = 0, limit = 100): Promise<Record<string, unknown>> {
  const isCookie = token.startsWith("COOKIE:");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isCookie) {
    headers["Cookie"] = token.replace("COOKIE:", "");
  } else {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const resp = await fetch(`${BASE}/api/quotes/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ from, to, limit, offset }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json() as Promise<Record<string, unknown>>;
}

interface ProjetRow { nom: string; client: string; mois: string; ht: number; date: string; }

const MOIS_FR: Record<string, number> = {
  janvier:1, fevrier:2, février:2, mars:3, avril:4, mai:5, juin:6,
  juillet:7, aout:8, août:8, septembre:9, octobre:10, novembre:11,
  decembre:12, décembre:12,
};

const MOIS_MAP: Record<string, string> = {
  "2026-4":"Avril 2026","2026-5":"Mai 2026","2026-6":"Juin 2026",
  "2026-7":"Juillet 2026","2026-8":"Août 2026","2026-9":"Septembre 2026",
  "2026-10":"Octobre 2026","2026-11":"Novembre 2026","2026-12":"Décembre 2026",
  "2027-1":"Janvier 2027","2027-2":"Février 2027","2027-3":"Mars 2027",
  "2027-4":"Avril 2027","2027-5":"Mai 2027","2027-6":"Juin 2027",
  "2027-7":"Juillet 2027","2027-8":"Août 2027","2027-9":"Septembre 2027",
  "2027-10":"Octobre 2027","2027-11":"Novembre 2027","2027-12":"Décembre 2027",
};

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function devinerMois(nom: string, fallback: string): string | null {
  const m1 = nom.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m1) return MOIS_MAP[`${m1[3]}-${parseInt(m1[2])}`] ?? null;
  const lower = norm(nom);
  for (const [mot, num] of Object.entries(MOIS_FR)) {
    const match = lower.match(new RegExp(norm(mot) + "[^\\d]*(\\d{4})"));
    if (match) return MOIS_MAP[`${match[1]}-${num}`] ?? null;
  }
  if (fallback?.length >= 7)
    return MOIS_MAP[`${parseInt(fallback.slice(0,4))}-${parseInt(fallback.slice(5,7))}`] ?? null;
  return null;
}

function traiterDevis(quotes: Record<string, unknown>[]): ProjetRow[] {
  const map = new Map<number, { nom: string; client: string; ht: number; date: string }>();
  for (const q of quotes) {
    const project = q.project as { id: number; name: string };
    const client  = q.client  as { name: string };
    const total   = q.total   as { ht: number };
    const pid = project.id;
    const date = q.date as string;
    const ht = parseFloat(String(total.ht)) || 0;
    const ex = map.get(pid);
    if (!ex || date >= ex.date) map.set(pid, { nom: project.name.trim(), client: client.name.trim(), ht, date });
  }
  const rows: ProjetRow[] = [];
  for (const p of map.values()) {
    if (p.ht <= 0) continue;
    const mois = devinerMois(p.nom, p.date);
    if (!mois) continue;
    rows.push({ nom: p.nom, client: p.client, mois, ht: p.ht, date: p.date });
  }
  const order = Object.values(MOIS_MAP);
  rows.sort((a, b) => {
    const d = order.indexOf(a.mois) - order.indexOf(b.mois);
    return d !== 0 ? d : b.ht - a.ht;
  });
  return rows;
}

export default async (req: Request): Promise<Response> => {
  if (!USER || !PASS)
    return Response.json({ success: false, error: "SEXTAN_USER / SEXTAN_PASS manquants" }, { status: 500 });

  const url  = new URL(req.url);
  const from = url.searchParams.get("from") ?? "2026-04-01";
  const to   = url.searchParams.get("to")   ?? "2026-12-31";

  try {
    const token = await getSextanToken();
    let allQuotes: Record<string, unknown>[] = [];
    let offset = 0;
    while (true) {
      const page  = await fetchQuotes(token, from, to, offset, 100);
      const data  = (page.data  ?? []) as Record<string, unknown>[];
      const count = (page.count ?? 0)  as number;
      allQuotes   = allQuotes.concat(data);
      if (allQuotes.length >= count || data.length === 0) break;
      offset += 100;
    }
    return Response.json({ success: true, count: allQuotes.length, from, to, data: traiterDevis(allQuotes) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ success: false, error: msg }, { status: 500 });
  }
};

export const config: Config = { path: "/api/sextan-quotes" };
