/**
 * Gallery SDK — fetch images, check payment status, retrieve URLs
 */

import NDK, { NDKEvent, type NDKUser } from '@nostr-dev-kit/ndk';
import type { GalleryImage, GalleryConfig, SDKOptions } from './types';
import { KIND_IMAGE_LISTING } from './kinds';

/**
 * Main gallery SDK class
 */
export class ZapGallerySDK {
	private ndk: NDK;
	private ownerPubkey: string;
	private relays: string[];
	private pollIntervalMs: number;

	private _images: GalleryImage[] = [];
	private _loading = true;
	private _subscription: any = null;  // Store subscription for cleanup

	constructor(config: GalleryConfig, options: SDKOptions = {}) {
		this.ownerPubkey = config.galleryOwnerPubkey;
		this.relays = config.relayUrls;
		this.pollIntervalMs = config.relayPollIntervalMs ?? 5000;

		this.ndk = new NDK({
			explicitRelayUrls: this.relays,
			enableOutgoingRelayMessages: false
		});
	}

	/**
	 * Connect to Nostr relays
	 */
	async connect(): Promise<void> {
		if (this.ndk.pool.connectedRelays.size > 0) return;
		await this.ndk.connect();
	}

	/**
	 * Disconnect from Nostr relays
	 */
	async disconnect(): Promise<void> {
		if (this._subscription) {
			this._subscription.stop();
			this._subscription = null;
		}
		this.ndk.pool.disconnect();
	}

	/**
	 * Get current gallery images (cached)
	 */
	get images(): GalleryImage[] {
		return this._images;
	}

	/**
	 * Get loading state
	 */
	get loading(): boolean {
		return this._loading;
	}

	/**
	 * Subscribe to gallery updates (real-time)
	 * Returns a callback to unsubscribe
	 */
	subscribe(callback?: (images: GalleryImage[]) => void): () => void {
		if (this._subscription || !this.ownerPubkey) {
			return () => {};
		}

		this._loading = true;
		this._images = [];

		this._subscription = this.ndk.subscribe(
			{
				kinds: [KIND_IMAGE_LISTING],
				authors: [this.ownerPubkey]
			},
			{ closeOnEose: false }
		);

		const imageMap = new Map<string, GalleryImage>();

		this._subscription.on('event', (event: NDKEvent) => {
			const image = parseImageEvent(event);
			if (image) {
				imageMap.set(image.slug, image);
				this._images = Array.from(imageMap.values()).sort((a, b) => b.createdAt - a.createdAt);
				this._loading = false;
				callback?.(this._images);
			}
		});

		this._subscription.on('eose', () => {
			this._loading = false;
		});

		return () => {
			if (this._subscription) {
				this._subscription.stop();
				this._subscription = null;
			}
		};
	}

	/**
	 * Manually refresh images (polling fallback)
	 */
	async refreshImages(): Promise<GalleryImage[]> {
		if (!this.ownerPubkey) return [];

		const events = await this.ndk.fetchEvents(
			{
				kinds: [KIND_IMAGE_LISTING],
				authors: [this.ownerPubkey]
			},
			undefined,
			5000  // 5s timeout
		);

		const imageMap = new Map<string, GalleryImage>();
		for (const event of events) {
			const image = parseImageEvent(event);
			if (image) {
				imageMap.set(image.slug, image);
			}
		}

		this._images = Array.from(imageMap.values()).sort((a, b) => b.createdAt - a.createdAt);
		this._loading = false;

		return this._images;
	}

	/**
	 * Get image by slug
	 */
	getImageBySlug(slug: string): GalleryImage | undefined {
		return this._images.find((img) => img.slug === slug);
	}

	/**
	 * Get images by filter (title, price range)
	 */
	filterImages(filter: {
		title?: string;
		minPriceSats?: number;
		maxPriceSats?: number;
	}): GalleryImage[] {
		return this._images.filter((img) => {
			if (filter.title && !img.title.toLowerCase().includes(filter.title.toLowerCase())) {
				return false;
			}
			if (filter.minPriceSats !== undefined && img.priceSats < filter.minPriceSats) {
				return false;
			}
			if (filter.maxPriceSats !== undefined && img.priceSats > filter.maxPriceSats) {
				return false;
			}
			return true;
		});
	}
}

/**
 * Parse a Nostr event into GalleryImage
 */
export function parseImageEvent(event: NDKEvent): GalleryImage | null {
	const slug = getTagValue(event, 'd');
	const title = getTagValue(event, 'title') ?? 'Untitled';
	const description = event.content ?? '';
	const priceSats = parseInt(getTagValue(event, 'price') ?? '0', 10);
	const thumbnailUrl = getTagValue(event, 'thumb') ?? '';
	const fullResUrl = getTagValue(event, 'full_res_url') ?? '';
	const mimeType = getTagValue(event, 'm') ?? 'image/jpeg';

	if (!slug || !thumbnailUrl) return null;

	return {
		slug,
		title,
		description,
		priceSats,
		thumbnailUrl,
		fullResUrl,
		mimeType,
		createdAt: event.created_at ?? 0,
		eventId: event.id
	};
}

/**
 * Get tag value by name
 */
function getTagValue(event: NDKEvent, tagName: string): string | undefined {
	const tag = event.tags.find(([t]) => t === tagName);
	return tag?.[1];
}
