import type { IncomingMessage, ServerResponse } from "http";
import { appPromise } from "../server/index";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await appPromise;
  return app(req, res);
}
