import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import aj, { detectBot, shield } from "@/lib/arcjet";

const securityCheck = aj
  .withRule(shield({ mode: "LIVE" }))
  .withRule(
    detectBot({
      mode: "LIVE",
      allow: ["CATEGORY:SEARCH_ENGINE", "CATEGORY:MONITOR"],
    })
  );

export async function middleware(request: NextRequest) {
  const decision = await securityCheck.protect(request);
  if (decision.isDenied()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|sign-in|assets|share).*)"],
};
