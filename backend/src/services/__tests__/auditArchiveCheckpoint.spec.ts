/**
 * Tests for AuditArchiveCheckpointStore.
 *
 * Validates:
 *  - load() returns null when no checkpoint file exists yet
 *  - save() persists checkpoint data to disk
 *  - clear() removes the checkpoint file
 *  - Corrupted checkpoint file (non-JSON) is detected and throws
 *    instead of silently returning null
 *  - File-not-found errors are distinguished from corruption errors
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import path from "path";
import { AuditArchiveCheckpointStore } from "../auditArchiveCheckpoint";

describe("AuditArchiveCheckpointStore", () => {
  let tempDir: string;
  let store: AuditArchiveCheckpointStore;

  beforeEach(async () => {
    tempDir = path.join("/tmp", `checkpoint-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    store = new AuditArchiveCheckpointStore(tempDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("load", () => {
    it("returns null when no checkpoint file exists yet", async () => {
      const result = await store.load();
      expect(result).toBeNull();
    });

    it("loads a valid checkpoint from disk", async () => {
      const checkpoint = {
        lastArchivedAt: "2024-06-01T12:00:00Z",
        tier: "warm" as const,
        totalArchived: 100,
        inProgress: true,
        startedAt: "2024-06-01T10:00:00Z",
      };

      const checkpointPath = path.join(tempDir, "audit", "checkpoint.json");
      await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
      await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf-8");

      const result = await store.load();
      expect(result).toEqual(checkpoint);
    });

    it("throws when checkpoint file exists but is corrupted (non-JSON)", async () => {
      const checkpointPath = path.join(tempDir, "audit", "checkpoint.json");
      await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
      // Write corrupted data (not valid JSON)
      await fs.writeFile(checkpointPath, "{ invalid json }", "utf-8");

      await expect(store.load()).rejects.toThrow();
    });

    it("throws when checkpoint file exists but is empty", async () => {
      const checkpointPath = path.join(tempDir, "audit", "checkpoint.json");
      await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
      await fs.writeFile(checkpointPath, "", "utf-8");

      await expect(store.load()).rejects.toThrow();
    });

    it("distinguishes between ENOENT (no file) and other errors", async () => {
      // Test: no file exists — should return null (not throw)
      const result1 = await store.load();
      expect(result1).toBeNull();

      // Write a corrupted file
      const checkpointPath = path.join(tempDir, "audit", "checkpoint.json");
      await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
      await fs.writeFile(checkpointPath, "not json", "utf-8");

      // Now it should throw (not return null)
      await expect(store.load()).rejects.toThrow();
    });
  });

  describe("save", () => {
    it("persists checkpoint to disk", async () => {
      const checkpoint = {
        lastArchivedAt: "2024-06-01T12:00:00Z",
        tier: "cold" as const,
        totalArchived: 500,
        inProgress: false,
        startedAt: "2024-06-01T10:00:00Z",
        completedAt: "2024-06-01T14:00:00Z",
      };

      await store.save(checkpoint);

      const checkpointPath = path.join(tempDir, "audit", "checkpoint.json");
      const content = await fs.readFile(checkpointPath, "utf-8");
      const loaded = JSON.parse(content);

      expect(loaded).toEqual(checkpoint);
    });

    it("creates directory if it does not exist", async () => {
      const checkpoint = {
        lastArchivedAt: "2024-06-01T12:00:00Z",
        tier: "warm" as const,
        totalArchived: 1,
        inProgress: true,
        startedAt: "2024-06-01T10:00:00Z",
      };

      await store.save(checkpoint);

      const checkpointPath = path.join(tempDir, "audit", "checkpoint.json");
      const exists = await fs.stat(checkpointPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it("overwrites existing checkpoint file", async () => {
      const checkpoint1 = {
        lastArchivedAt: "2024-06-01T12:00:00Z",
        tier: "warm" as const,
        totalArchived: 100,
        inProgress: true,
        startedAt: "2024-06-01T10:00:00Z",
      };

      const checkpoint2 = {
        lastArchivedAt: "2024-06-02T12:00:00Z",
        tier: "cold" as const,
        totalArchived: 200,
        inProgress: false,
        startedAt: "2024-06-02T10:00:00Z",
        completedAt: "2024-06-02T14:00:00Z",
      };

      await store.save(checkpoint1);
      await store.save(checkpoint2);

      const checkpointPath = path.join(tempDir, "audit", "checkpoint.json");
      const content = await fs.readFile(checkpointPath, "utf-8");
      const loaded = JSON.parse(content);

      expect(loaded).toEqual(checkpoint2);
    });
  });

  describe("clear", () => {
    it("removes the checkpoint file", async () => {
      const checkpoint = {
        lastArchivedAt: "2024-06-01T12:00:00Z",
        tier: "warm" as const,
        totalArchived: 100,
        inProgress: true,
        startedAt: "2024-06-01T10:00:00Z",
      };

      await store.save(checkpoint);

      const checkpointPath = path.join(tempDir, "audit", "checkpoint.json");
      let exists = await fs.stat(checkpointPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      await store.clear();

      exists = await fs.stat(checkpointPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("does not throw if checkpoint file does not exist", async () => {
      await expect(store.clear()).resolves.not.toThrow();
    });
  });

  describe("getCached", () => {
    it("returns null when no checkpoint has been loaded or saved", () => {
      expect(store.getCached()).toBeNull();
    });

    it("returns the cached checkpoint after save", async () => {
      const checkpoint = {
        lastArchivedAt: "2024-06-01T12:00:00Z",
        tier: "warm" as const,
        totalArchived: 100,
        inProgress: true,
        startedAt: "2024-06-01T10:00:00Z",
      };

      await store.save(checkpoint);
      expect(store.getCached()).toEqual(checkpoint);
    });

    it("returns the cached checkpoint after load", async () => {
      const checkpoint = {
        lastArchivedAt: "2024-06-01T12:00:00Z",
        tier: "warm" as const,
        totalArchived: 100,
        inProgress: true,
        startedAt: "2024-06-01T10:00:00Z",
      };

      const checkpointPath = path.join(tempDir, "audit", "checkpoint.json");
      await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
      await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf-8");

      await store.load();
      expect(store.getCached()).toEqual(checkpoint);
    });

    it("clears cache after clear()", async () => {
      const checkpoint = {
        lastArchivedAt: "2024-06-01T12:00:00Z",
        tier: "warm" as const,
        totalArchived: 100,
        inProgress: true,
        startedAt: "2024-06-01T10:00:00Z",
      };

      await store.save(checkpoint);
      expect(store.getCached()).toEqual(checkpoint);

      await store.clear();
      expect(store.getCached()).toBeNull();
    });
  });
});
