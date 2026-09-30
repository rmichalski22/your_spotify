import { connect as connectToDb, Mongoose } from "mongoose";

import { getWithDefault } from "../tools/env";
import { logger } from "../tools/logger";
import { wait } from "../tools/misc";

export * from "./queries/stats";
export * from "./queries/user";
export * from "./queries/global";
export * from "./queries/artist";
export * from "./queries/track";

const TRIES = 10;
const WAIT_MS = 30_000;

export const connect = async () => {
  const fallbackConnection = "mongodb://mongo:27017/your_spotify";
  const endpoint = getWithDefault("MONGO_ENDPOINT", fallbackConnection);
  logger.info(`Trying to connect to database at ${endpoint}`);
  let lastError: Error | undefined;
  for (let i = 0; i < TRIES; i += 1) {
    try {
      const client: Mongoose = await connectToDb(endpoint, {
        connectTimeoutMS: 3000,
      });
      logger.info("Connected to database !");
      return client;
    } catch (e) {
      lastError = e;
      logger.error(
        `Failed to connect to database, try ${i + 1}/${TRIES}:`,
        e instanceof Error ? e.message : e,
      );
      if (i < TRIES - 1) {
        await wait(WAIT_MS);
      }
    }
  }
  throw lastError;
};
