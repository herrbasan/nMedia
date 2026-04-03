import { assetCache } from '../../cache/AssetCache.js';
import logger from '../../utils/logger.js';

/**
 * GET /v1/assets/:id
 * Download an asset file
 */
export async function handleGetAsset(ctx) {
  try {
    const { id } = ctx.params;

    if (!id) {
      ctx.error(400, 'Asset ID is required');
      return;
    }

    const asset = assetCache.get(id);

    if (!asset) {
      ctx.error(404, `Asset not found: ${id}`);
      return;
    }

    const buffer = assetCache.getBuffer(id);
    if (!buffer) {
      ctx.error(404, `Asset file not found: ${id}`);
      return;
    }

    const filename = `${asset.id}.${assetCache._getExtension(asset.mimeType)}`;
    ctx.send(200, buffer, asset.mimeType, filename);
  } catch (error) {
    logger.error('Get asset failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * GET /v1/assets/:id/metadata
 * Get asset metadata
 */
export async function handleGetAssetMetadata(ctx) {
  try {
    const { id } = ctx.params;

    if (!id) {
      ctx.error(400, 'Asset ID is required');
      return;
    }

    const asset = assetCache.get(id);

    if (!asset) {
      ctx.error(404, `Asset not found: ${id}`);
      return;
    }

    ctx.json(200, {
      id: asset.id,
      type: asset.type,
      mimeType: asset.mimeType,
      size: asset.size,
      createdAt: new Date(asset.createdAt).toISOString(),
      expiresAt: new Date(asset.expiresAt).toISOString(),
      metadata: asset.metadata,
    });
  } catch (error) {
    logger.error('Get asset metadata failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * DELETE /v1/assets/:id
 * Delete a specific asset
 */
export async function handleDeleteAsset(ctx) {
  try {
    const { id } = ctx.params;

    if (!id) {
      ctx.error(400, 'Asset ID is required');
      return;
    }

    const deleted = assetCache.delete(id);

    if (!deleted) {
      ctx.error(404, `Asset not found: ${id}`);
      return;
    }

    ctx.json(200, {
      id,
      message: 'Asset deleted successfully',
    });
  } catch (error) {
    logger.error('Delete asset failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * DELETE /v1/assets
 * Clear all assets (admin)
 */
export async function handleClearAssets(ctx) {
  try {
    const cleared = assetCache.clear();

    ctx.json(200, {
      message: 'All assets cleared',
      count: cleared,
    });
  } catch (error) {
    logger.error('Clear assets failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * GET /v1/assets
 * List all assets (with optional filters)
 */
export async function handleListAssets(ctx) {
  try {
    const { type, limit } = ctx.query;

    let assets = assetCache.getAll();

    // Filter by type
    if (type && ['image', 'audio', 'video'].includes(type)) {
      assets = assets.filter((a) => a.type === type);
    }

    // Sort by createdAt descending
    assets.sort((a, b) => b.createdAt - a.createdAt);

    // Apply limit
    const maxLimit = parseInt(limit) || 100;
    assets = assets.slice(0, maxLimit);

    ctx.json(200, {
      assets: assets.map((a) => ({
        id: a.id,
        type: a.type,
        mimeType: a.mimeType,
        size: a.size,
        createdAt: new Date(a.createdAt).toISOString(),
        expiresAt: new Date(a.expiresAt).toISOString(),
      })),
      total: assets.length,
      stats: assetCache.getStats(),
    });
  } catch (error) {
    logger.error('List assets failed', { error: error.message });
    ctx.error(500, error.message);
  }
}