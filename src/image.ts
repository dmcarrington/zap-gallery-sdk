/**
 * Image operations — download URLs, decryption, DM delivery
 */

import NDK, { NDKEvent, NDKUser, NDKPrivateKeySigner, type NDKSigner } from '@nostr-dev-kit/ndk';
import type { GalleryConfig, DownloadResponse } from './types';
import { collectEvents } from './gallery';
import { KIND_APP_DATA, KIND_IMAGE_LISTING, KIND_ENCRYPTED_DM } from './kinds';

export interface ZapImageSDKInjection {
	ndk: NDK;
	signer: NDKSigner;
	ownerPubkey: string;
}

const IMAGE_URL_TIMEOUT_MS = 8000;

/**
 * Image SDK — retrieve full-res URLs after payment verification
 */
export class ZapImageSDK {
	private ndk: NDK;
	private ownerPubkey: string;
	private signer: NDKSigner | null;
	private ownsNdk: boolean;

	/**
	 * Construct from a bare config (builds its own NDK) or from an existing
	 * NDK + signer pair (use `ZapImageSDK.fromNdk` for that form).
	 */
	constructor(config: GalleryConfig, ownerNsec?: string) {
		this.ownerPubkey = config.galleryOwnerPubkey;
		this.ndk = new NDK({ explicitRelayUrls: config.relays });
		this.signer = ownerNsec ? new NDKPrivateKeySigner(ownerNsec) : null;
		this.ownsNdk = true;
	}

	/**
	 * Build a ZapImageSDK that reuses an existing NDK instance and signer.
	 * Useful on servers that already maintain a shared NDK connection pool.
	 */
	static fromNdk(injection: ZapImageSDKInjection): ZapImageSDK {
		const instance = Object.create(ZapImageSDK.prototype) as ZapImageSDK;
		(instance as unknown as { ndk: NDK }).ndk = injection.ndk;
		(instance as unknown as { ownerPubkey: string }).ownerPubkey = injection.ownerPubkey;
		(instance as unknown as { signer: NDKSigner | null }).signer = injection.signer;
		(instance as unknown as { ownsNdk: boolean }).ownsNdk = false;
		return instance;
	}

	/**
	 * Connect to relays. No-op when the SDK was built from an external NDK.
	 */
	async connect(): Promise<void> {
		if (!this.ownsNdk) return;
		await this.ndk.connect();
	}

	/**
	 * Disconnect from relays. No-op when the SDK was built from an external NDK.
	 */
	async disconnect(): Promise<void> {
		if (!this.ownsNdk) return;
		for (const relay of this.ndk.pool.relays.values()) {
			relay.disconnect();
		}
	}

	/**
	 * Get full-res image URL after verifying payment. Callers should perform
	 * the zap/invoice verification before invoking this method.
	 */
	async getFullResUrl(buyerPubkey: string, slug: string): Promise<DownloadResponse> {
		const event = await this.fetchEncryptedUrlEvent(slug);
		if (!event) {
			throw new Error('Image URL not found');
		}

		const decrypted = await this.decryptUrlEvent(event);
		if (!decrypted) {
			throw new Error('Failed to decrypt image URL');
		}

		if (this.signer) {
			void this.sendDmToBuyer(buyerPubkey, decrypted);
		}

		return decrypted;
	}

	/**
	 * Create a kind 30024 image listing event (public metadata).
	 */
	createImageEvent(
		slug: string,
		title: string,
		description: string,
		priceSats: number,
		thumbnailUrl: string,
		fullResUrl: string,
		mimeType: string = 'image/jpeg'
	): NDKEvent {
		const event = new NDKEvent(this.ndk);
		event.kind = KIND_IMAGE_LISTING;
		event.content = description;
		event.tags = [
			['d', slug],
			['title', title],
			['price', priceSats.toString()],
			['thumb', thumbnailUrl],
			['full_res_url', fullResUrl],
			['m', mimeType]
		];
		return event;
	}

	/**
	 * Create a kind 30078 event that carries the NIP-04-encrypted full-res URL
	 * for `slug`. The payload is encrypted to the gallery owner so only the
	 * owner's signer can unlock it later. Returns a signed event ready to
	 * publish.
	 */
	async createImageUrlEvent(
		slug: string,
		payload: { url: string; mimeType?: string }
	): Promise<NDKEvent> {
		if (!this.signer) {
			throw new Error('Signer not provided — cannot create encrypted URL event');
		}

		const owner = new NDKUser({ pubkey: this.ownerPubkey });
		owner.ndk = this.ndk;

		const body = JSON.stringify({
			url: payload.url,
			mimeType: payload.mimeType ?? 'image/jpeg'
		});

		const ciphertext = await this.signer.encrypt(owner, body, 'nip04');

		const event = new NDKEvent(this.ndk);
		event.kind = KIND_APP_DATA;
		event.content = ciphertext;
		event.tags = [
			['d', `zap-gallery-url:${slug}`],
			['m', payload.mimeType ?? 'image/jpeg']
		];

		await event.sign(this.signer);
		return event;
	}

	private async fetchEncryptedUrlEvent(slug: string): Promise<NDKEvent | null> {
		const events = await collectEvents(
			this.ndk,
			{
				kinds: [KIND_APP_DATA],
				authors: [this.ownerPubkey],
				'#d': [`zap-gallery-url:${slug}`]
			},
			IMAGE_URL_TIMEOUT_MS
		);
		// Parameterized replaceable events: pick the most recent.
		let latest: NDKEvent | null = null;
		for (const event of events) {
			if (!latest || (event.created_at ?? 0) > (latest.created_at ?? 0)) {
				latest = event;
			}
		}
		return latest;
	}

	private async decryptUrlEvent(event: NDKEvent): Promise<DownloadResponse | null> {
		if (!this.signer) {
			throw new Error('Signer not provided — cannot decrypt');
		}

		try {
			const ownerUser = new NDKUser({ pubkey: this.ownerPubkey });
			ownerUser.ndk = this.ndk;

			const decrypted = await this.signer.decrypt(ownerUser, event.content, 'nip04');
			const data = JSON.parse(decrypted);

			return {
				url: data.url,
				mimeType: data.mimeType || this.getMimeType(event)
			};
		} catch {
			return null;
		}
	}

	private getMimeType(event: NDKEvent): string {
		const mimeTypeTag = event.tags.find((t) => t[0] === 'm');
		return mimeTypeTag?.[1] ?? 'image/jpeg';
	}

	private async sendDmToBuyer(buyerPubkey: string, urlData: DownloadResponse): Promise<void> {
		if (!this.signer) return;

		const buyerUser = new NDKUser({ pubkey: buyerPubkey });
		buyerUser.ndk = this.ndk;

		const payload = JSON.stringify({
			type: 'zap-gallery-url',
			...urlData
		});

		try {
			const encrypted = await this.signer.encrypt(buyerUser, payload, 'nip04');

			const event = new NDKEvent(this.ndk);
			event.kind = KIND_ENCRYPTED_DM;
			event.content = encrypted;
			event.tags = [['p', buyerPubkey]];

			await event.sign(this.signer);
			await event.publish();
		} catch (err) {
			console.warn('[ZapImageSDK] Failed to send DM to buyer:', err);
		}
	}
}
