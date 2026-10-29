import { getStore } from "@netlify/blobs";
import { createGameService, handleGameRequest } from "../lib/game-service.js";

export default async function game(request: Request): Promise<Response> {
  const store = getStore({ name: "pulse-club-games", consistency: "strong" });
  const service = createGameService({ store, roundLimit: 5 });
  return handleGameRequest(request, service);
}
