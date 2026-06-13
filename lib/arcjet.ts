import arcjet, {
  detectBot,
  fixedWindow,
  shield,
  request,
  validateEmail,
  slidingWindow,
  ArcjetDecision,
  createMiddleware,
  type ArcjetRequest,
} from "@arcjet/next";

export {
  detectBot,
  fixedWindow,
  shield,
  request,
  slidingWindow,
  validateEmail,
  createMiddleware,
  ArcjetDecision,
};

let _aj: ReturnType<typeof arcjet> | null = null;

function getAj() {
  if (!_aj) {
    const key = process.env.ARCJET_API_KEY;
    if (!key) throw new Error("Missing required env: ARCJET_API_KEY");
    _aj = arcjet({ key, rules: [] });
  }
  return _aj;
}

const aj = new Proxy({} as ReturnType<typeof arcjet>, {
  get(_, prop: string | symbol) {
    return Reflect.get(getAj(), prop);
  },
});

export default aj;
