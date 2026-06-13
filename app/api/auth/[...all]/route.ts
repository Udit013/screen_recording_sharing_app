import aj, { ArcjetDecision, shield, slidingWindow, validateEmail } from "@/lib/arcjet";
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { NextRequest } from "next/server";

const getClientIp = (req: NextRequest): string =>
  req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
  req.headers.get("x-real-ip") ??
  "127.0.0.1";

const protectedAuth = async (req: NextRequest): Promise<ArcjetDecision> => {
  const session = await auth.api.getSession({ headers: req.headers });
  const fingerprint = session?.user.id ?? getClientIp(req);

  if (req.nextUrl.pathname.startsWith("/api/auth/sign-in")) {
    const body = await req.clone().json().catch(() => ({}));
    if (typeof body.email === "string") {
      return aj
        .withRule(validateEmail({ mode: "LIVE", block: ["DISPOSABLE", "INVALID", "NO_MX_RECORDS"] }))
        .protect(req, { email: body.email });
    }
  }

  if (!req.nextUrl.pathname.startsWith("/api/auth/sign-out")) {
    return aj
      .withRule(slidingWindow({ mode: "LIVE", interval: "2m", max: 10, characteristics: ["fingerprint"] }))
      .protect(req, { fingerprint });
  }

  return aj.withRule(shield({ mode: "LIVE" })).protect(req);
};

const authHandlers = toNextJsHandler(auth.handler);
export const { GET } = authHandlers;

export const POST = async (req: NextRequest) => {
  const decision = await protectedAuth(req);
  if (decision.isDenied()) {
    if (decision.reason.isEmail()) {
      return new Response(JSON.stringify({ error: "Email validation failed" }), { status: 400 });
    }
    if (decision.reason.isRateLimit()) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 });
    }
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  }
  return authHandlers.POST(req);
};
