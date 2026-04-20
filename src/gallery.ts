/**
 * Gallery SDK — fetch images, check payment status, retrieve URLs
 */

import NDK, { NDKEvent, NDKSubscription } from '@nostr-dev-kit/ndk';
import type { GalleryImage, GalleryConfig } from './types.js';
import { KIND_IMAGE_LISTING } from './kinds.js';

const DEFAULT_FETCH_TIMEOUT_MS = 5000;

/**
 * Main gallery SDK class
 */
export class ZapGallerySDK {
	private ndk: NDK;
	private ownerPubkey: string;
	private relays: string[];

	private _images: GalleryImage[] = [];
	private _loading = true;
	private _subscription: NDKSubscription | null = null;

	constructor(config: GalleryConfig) {
		this.ownerPubkey = config.galleryOwnerPubkey;
		this.relays = config.relays;

		this.ndk = new NDK({
			explicitRelayUrls: this.relays
		});
	}

	/**
	 * Connect to Nostr relays
	 */
	async connect(): Promise<void> {
		if (this.ndk.pool.connectedRelays().length > 0) return;
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
		for (const relay of this.ndk.pool.relays.values()) {
			relay.disconnect();
		}
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
	 * Manually refresh images using a raw subscription with a hard timeout.
	 * Resolves after `timeoutMs` with whatever events arrived, rather than
	 * waiting for EOSE from a majority of relays.
	 */
	async refreshImages(timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS): Promise<GalleryImage[]> {
		if (!this.ownerPubkey) return [];

		const events = await collectEvents(
			this.ndk,
			{ kinds: [KIND_IMAGE_LISTING], authors: [this.ownerPubkey] },
			timeoutMs
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
 * Run a NDK subscription and resolve after a hard timeout with whatever
 * events arrived. A single slow relay cannot stall the promise.
 */
export function collectEvents(
	ndk: NDK,
	filter: Parameters<NDK['subscribe']>[0],
	timeoutMs: number
): Promise<NDKEvent[]> {
	return new Promise((resolve) => {
		const events = new Map<string, NDKEvent>();
		const sub = ndk.subscribe(filter, { closeOnEose: false });

		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			sub.stop();
			resolve(Array.from(events.values()));
		};

		sub.on('event', (event: NDKEvent) => {
			events.set(event.id, event);
		});
		sub.on('eose', () => {
			finish();
		});

		setTimeout(finish, timeoutMs);
	});
}

function getTagValue(event: NDKEvent, tagName: string): string | undefined {
	const tag = event.tags.find(([t]) => t === tagName);
	return tag?.[1];
}
