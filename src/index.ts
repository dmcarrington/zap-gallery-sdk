/**
 * Zap Gallery SDK
 *
 * A TypeScript SDK for integrating with Nostr Zap Gallery — monetize images via Lightning zaps.
 *
 * This SDK allows you to:
 * - List and query images from a Zap Gallery
 * - Check payment status for images
 * - Retrieve decrypted image URLs after payment
 * - Integrate with Blossom media servers
 * - Interact with Nostr relays for event publication and subscription
 *
 * @module zap-gallery-sdk
 */

export * from './gallery.js';
export * from './payment.js';
export * from './image.js';
export * from './types.js';
export * from './kinds.js';
