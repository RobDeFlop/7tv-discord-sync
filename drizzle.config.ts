import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/adapters/store/schema.ts",
  out: "./src/adapters/store/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
