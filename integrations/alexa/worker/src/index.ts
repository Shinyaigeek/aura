// Cloudflare Worker that is the Alexa custom-skill endpoint for aura.
//
//   Echo → Alexa cloud → THIS WORKER → (Cloudflare Access) → cloudflared → aura
//
// Two things a user can do by voice:
//   • "アレクサ、オーラに <prompt> って伝えて"  → SendPromptIntent
//        POSTs the prompt into the session's Claude Code prompt and acks.
//   • "アレクサ、オーラに 返事は？"              → ReadReplyIntent
//        GETs the session's last assistant message and reads it aloud.
//
// Claude Code takes minutes; Alexa wants a reply in seconds. So this is
// deliberately two-phase: send returns immediately, the answer is fetched on a
// later utterance (or pushed via mobile). No long blocking here.

import { verifyAlexaRequest } from "./alexa-verify";

interface Env {
  AURA_BASE_URL: string; // https hostname the tunnel exposes, e.g. https://aura.example.com
  AURA_TOKEN: string; // bearer token the aura server checks
  ALEXA_SKILL_ID: string; // amzn1.ask.skill.xxxx — the only skill allowed to call us
  AURA_SESSION?: string; // logical session id to drive; defaults to "default"
  CF_ACCESS_CLIENT_ID?: string; // Cloudflare Access service-token id (if aura is behind Access)
  CF_ACCESS_CLIENT_SECRET?: string;
}

const MAX_SPOKEN_CHARS = 600; // keep TTS short; long Claude answers get truncated.

function speak(text: string, endSession = true): Response {
  return Response.json({
    version: "1.0",
    response: {
      outputSpeech: { type: "PlainText", text },
      shouldEndSession: endSession,
    },
  });
}

function auraHeaders(env: Env): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${env.AURA_TOKEN}`,
    "Content-Type": "application/json",
  };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    h["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    h["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  return h;
}

async function handleSend(env: Env, sessionId: string, prompt: string): Promise<Response> {
  const trimmed = prompt.trim();
  if (!trimmed) return speak("何を伝えるか聞き取れへんかった。もう一回言ってくれる？", false);

  const res = await fetch(`${env.AURA_BASE_URL}/sessions/${sessionId}/input`, {
    method: "POST",
    headers: auraHeaders(env),
    body: JSON.stringify({ text: trimmed }),
  });
  if (res.status === 404) return speak("セッションがまだ起動してへんみたい。");
  if (!res.ok) return speak("送るのに失敗してもうた。");
  return speak("クロードに送っといたで。");
}

async function handleReadReply(env: Env, sessionId: string): Promise<Response> {
  const res = await fetch(`${env.AURA_BASE_URL}/sessions/${sessionId}/last-reply`, {
    headers: auraHeaders(env),
  });
  if (res.status === 404) return speak("まだ返事は来てへんで。");
  if (!res.ok) return speak("返事の取得に失敗してもうた。");

  const data = (await res.json()) as { summary?: string; body?: string };
  const text = (data.summary || data.body || "").trim();
  if (!text) return speak("返事は来てるけど、読み上げられる中身がなかったわ。");

  const spoken = text.length > MAX_SPOKEN_CHARS ? text.slice(0, MAX_SPOKEN_CHARS) + "、以下省略。" : text;
  return speak(spoken);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    // Read the raw bytes once: signature verification needs the exact body.
    const raw = await req.arrayBuffer();
    let body: any;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return new Response("bad json", { status: 400 });
    }

    const verdict = await verifyAlexaRequest(req, raw, body, env.ALEXA_SKILL_ID);
    if (!verdict.ok) {
      // 400, not 401 — Alexa expects 400 for rejected requests.
      return new Response(`rejected: ${verdict.reason}`, { status: 400 });
    }

    const sessionId = env.AURA_SESSION || "default";
    const type: string = body?.request?.type;

    if (type === "LaunchRequest") {
      return speak("オーラやで。クロードに何を伝える？", false);
    }
    if (type === "SessionEndedRequest") {
      return speak("ほな。");
    }
    if (type === "IntentRequest") {
      const intent = body.request.intent?.name as string;
      switch (intent) {
        case "SendPromptIntent": {
          const prompt = body.request.intent?.slots?.prompt?.value ?? "";
          return handleSend(env, sessionId, prompt);
        }
        case "ReadReplyIntent":
          return handleReadReply(env, sessionId);
        case "AMAZON.HelpIntent":
          return speak("クロードに伝えたいことをそのまま言うてな。返事は『返事は？』で聞けるで。", false);
        case "AMAZON.StopIntent":
        case "AMAZON.CancelIntent":
        case "AMAZON.NavigateHomeIntent":
          return speak("ほな。");
        default:
          return speak("ごめん、それは分からへんかった。", false);
      }
    }

    return speak("ごめん、うまく処理できへんかった。");
  },
};
