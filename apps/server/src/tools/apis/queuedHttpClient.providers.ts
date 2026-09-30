import { getWithDefault } from "../env";
import { QueuedHttpClientFactory } from "./queueHttpClient";

export const spotifyHttpClientFactory = new QueuedHttpClientFactory({
  baseURL: "https://api.spotify.com/v1",
  headers: { "Content-Type": "application/json" },
  maxRequestsPerWindow: getWithDefault("SPOTIFY_REQUESTS_PER_30_SECONDS", 10),
});

export const githubHttpClientFactory = new QueuedHttpClientFactory({
  baseURL: "https://api.github.com",
  headers: { "Content-Type": "application/json" },
});
