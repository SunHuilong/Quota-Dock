"use strict";

const PROVIDER_PREFIX = "quota-provider/";
const DELETED_PROVIDER_PREFIX = "quota-deleted-provider/";
const REMOVE_RETRY_COUNT = 3;
const PUT_RETRY_COUNT = 3;

function createProviderStore(getDb) {
  if (typeof getDb !== "function") {
    throw new TypeError("getDb 必须是函数");
  }

  function db() {
    const value = getDb();

    if (!value || typeof value.get !== "function" || typeof value.put !== "function") {
      throw new Error("当前环境未检测到可用的数据库 API");
    }

    return value;
  }

  function normalizeId(id) {
    return String(id || "").trim();
  }

  function providerDocId(id) {
    return `${PROVIDER_PREFIX}${normalizeId(id)}`;
  }

  function deletedProviderDocId(id) {
    return `${DELETED_PROVIDER_PREFIX}${normalizeId(id)}`;
  }

  function idFromDoc(doc) {
    return String((doc && doc._id) || "").slice(PROVIDER_PREFIX.length);
  }

  function idFromDeletedDoc(doc) {
    return String((doc && doc._id) || "").slice(DELETED_PROVIDER_PREFIX.length);
  }

  function assertDbResult(result, action) {
    if (result && result.ok) {
      return;
    }

    const message = result && result.message ? result.message : `${action}失败`;
    const error = new Error(message);
    if (result && typeof result === "object") {
      error.status = result.status || result.statusCode;
      error.code = result.code || result.error || result.name;
    }
    throw error;
  }

  function isConflictError(error) {
    const status = Number(error && (error.status || error.statusCode));
    const code = String((error && (error.name || error.code || error.error)) || "").toLowerCase();
    const message = String((error && error.message) || "").toLowerCase();
    return status === 409 || code.includes("conflict") || message.includes("conflict") || message.includes("冲突");
  }

  async function getLiveDoc(docId) {
    const doc = await db().get(docId);
    return doc && !doc._deleted ? doc : null;
  }

  async function isProviderDeleted(id) {
    return Boolean(await getLiveDoc(deletedProviderDocId(id)));
  }

  async function getProviderDoc(id) {
    if (await isProviderDeleted(id)) {
      throw new Error("站点已删除");
    }

    const doc = await getLiveDoc(providerDocId(id));

    if (!doc) {
      throw new Error("站点不存在");
    }

    // The marker may have been created while the provider document was being read.
    if (await isProviderDeleted(id)) {
      throw new Error("站点已删除");
    }

    return doc;
  }

  async function listProviderDocs() {
    const database = db();
    const [docs, deletedDocs] = await Promise.all([
      database.allDocs(PROVIDER_PREFIX),
      database.allDocs(DELETED_PROVIDER_PREFIX)
    ]);
    const deletedIds = new Set(
      deletedDocs.filter((doc) => doc && !doc._deleted).map(idFromDeletedDoc)
    );

    return docs
      .filter((doc) => doc && !doc._deleted && !deletedIds.has(idFromDoc(doc)))
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  }

  async function putNewProviderDoc(doc) {
    const result = await db().put(doc);
    assertDbResult(result, "保存站点");
    return getProviderDoc(idFromDoc(doc));
  }

  async function updateProviderDoc(id, updater) {
    if (typeof updater !== "function") {
      throw new TypeError("updater 必须是函数");
    }

    let lastError = null;
    for (let attempt = 0; attempt < PUT_RETRY_COUNT; attempt += 1) {
      const current = await getProviderDoc(id);
      const next = await updater(current);

      if (next === null || next === undefined) {
        return current;
      }

      const doc = {
        ...next,
        _id: current._id,
        _rev: current._rev
      };

      try {
        const result = await db().put(doc);
        assertDbResult(result, "保存站点");
        return getProviderDoc(id);
      } catch (error) {
        lastError = error;
        if (!isConflictError(error)) {
          throw error;
        }
      }
    }

    throw lastError || new Error("保存站点失败");
  }

  function putProviderPatch(id, patch) {
    return updateProviderDoc(id, (current) => ({
      ...current,
      ...patch
    }));
  }

  async function ensureDeletedMarker(id) {
    const docId = deletedProviderDocId(id);
    const existing = await getLiveDoc(docId);

    if (existing) {
      return existing;
    }

    const deletedAt = new Date().toISOString();
    let result;

    try {
      result = await db().put({
        _id: docId,
        providerId: normalizeId(id),
        deletedAt
      });
      assertDbResult(result, "记录删除状态");
    } catch (error) {
      const concurrentMarker = await getLiveDoc(docId);

      if (concurrentMarker) {
        return concurrentMarker;
      }

      throw error;
    }

    return { _id: docId, providerId: normalizeId(id), deletedAt, _rev: result.rev };
  }

  async function removeProviderDoc(id, initialDoc) {
    let current = initialDoc;
    let lastError = null;

    for (let attempt = 0; attempt < REMOVE_RETRY_COUNT && current; attempt += 1) {
      try {
        const result = await db().remove(current);
        assertDbResult(result, "删除站点");
        return null;
      } catch (error) {
        lastError = error;
        try {
          current = await getLiveDoc(providerDocId(id));
        } catch (readError) {
          return readError;
        }
      }
    }

    return lastError;
  }

  async function deleteProviderDoc(id) {
    const current = await getLiveDoc(providerDocId(id));

    // This separate document survives stale provider revisions arriving from cloud sync.
    await ensureDeletedMarker(id);
    const removeError = current ? await removeProviderDoc(id, current) : null;

    return {
      hardDeleted: !removeError,
      removeError
    };
  }

  return {
    providerDocId,
    idFromDoc,
    getProviderDoc,
    listProviderDocs,
    putNewProviderDoc,
    updateProviderDoc,
    putProviderPatch,
    deleteProviderDoc,
    isProviderDeleted
  };
}

module.exports = {
  PROVIDER_PREFIX,
  DELETED_PROVIDER_PREFIX,
  createProviderStore
};
