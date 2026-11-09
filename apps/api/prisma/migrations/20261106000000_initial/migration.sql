CREATE TABLE "Room" ("code" TEXT PRIMARY KEY, "state" JSONB NOT NULL);
CREATE TABLE "Drawing" ("roomCode" TEXT NOT NULL, "canvasId" TEXT NOT NULL, "generation" INTEGER NOT NULL, "sequence" INTEGER NOT NULL, "operations" JSONB NOT NULL, PRIMARY KEY ("roomCode", "canvasId", "generation", "sequence"));
CREATE TABLE "TurnResult" ("turnId" TEXT NOT NULL, "generation" INTEGER NOT NULL, "roomCode" TEXT NOT NULL, "results" JSONB NOT NULL, PRIMARY KEY ("turnId", "generation"));
