/**
 * Image operations — download URLs, decryption, DM delivery
 */

import NDK, { NDKEvent, NDKUser, NDKPrivateKeySigner, type NDK } from '@nostr-dev-kit/ndk';
import { nip04 } from 'nostr-tools';
import type { GalleryConfig, DownloadResponse } from './types';
import { KIND_APP_DATA } from './kinds';

/**
 * Image SDK — retrieve full-res URLs after payment verification
 */
export class ZapImageSDK {
	private ndk: NDK;
	private ownerPubkey: string;
	private signer: NDKPrivateKeySigner | null;

	constructor(config: GalleryConfig, ownerNsec?: string) {
		this.ownerPubkey = config.galleryOwnerPubkey;
		this.ndk = new NDK({
			explicitRelayUrls: config.relayUrls
		});

		if (ownerNsec) {
			this.signer = new NDKPrivateKeySigner(ownerNsec);
		} else {
			this.signer = null;
		}
	}

	/**
	 * Connect to relays
	 */
	async connect(): Promise<void> {
		await this.ndk.connect();
	}

	/**
	 * Disconnect from relays
	 */
	async disconnect(): Promise<void> {
		this.ndk.pool.disconnect();
	}

	/**
	 * Get full-res image URL after verifying payment
	 * This is typically called by your API endpoint after verifying the zap
	 */
	async getFullResUrl(
		buyerPubkey: string,
		slug: string,
		imageEventId: string,
		requiredSats: number
	): Promise<DownloadResponse> {
		// Step 1: Verify payment (this would be done before calling this method)
		// Step 2: Fetch encrypted image URL from kind 30078
		const urlData = await this.fetchEncryptedImageUrl(slug);
		if (!urlData) {
			throw new Error('Image URL not found');
		}

		// Step 3: Decrypt the URL
		const decrypted = this.decryptUrl(urlData);
		if (!decrypted) {
			throw new Error('Failed to decrypt image URL');
		}

		// Step 4: Send decryption key to buyer via NIP-04 DM (optional)
		if (this.signer) {
			void this.sendDmToBuyer(buyerPubkey, decrypted);
		}

		return decrypted;
	}

	/**
	 * Fetch encrypted image URL from kind 30078 events
	 */
	private async fetchEncryptedImageUrl(slug: string): Promise<DownloadResponse | null> {
		const events = await this.ndk.fetchEvents(
			{
				kinds: [KIND_APP_DATA],
				authors: [this.ownerPubkey],
				'#d': [`zap-gallery-url:${slug}`]
			},
			undefined,
			8000  // 8s timeout
		);

		const event = Array.from(events)[0];
		if (!event) return null;

		return {
			url: event.content,  // Will be decrypted
			mimeType: this.getMimeType(event)
		};
	}

	/**
	 * Decrypt image URL
	 */
	private decryptUrl(event: NDKEvent): DownloadResponse | null {
		if (!this.signer) {
			throw new Error('Owner private key (nsec) not provided — cannot decrypt');
		}

		try {
			const ownerUser = new NDKUser({ pubkey: this.ownerPubkey });
			ownerUser.ndk = this.ndk;

			const decrypted = this.signer.decrypt(ownerUser, event.content, 'nip04');
			const data = JSON.parse(decrypted);

			return {
				url: data.url,
				mimeType: data.mimeType || 'image/jpeg'
			};
		} catch (err) {
			return null;
		}
	}

	/**
	 * Get MIME type from event tags
	 */
	private getMimeType(event: NDKEvent): string {
		const mimeTypeTag = event.tags.find((t) => t[0] === 'm');
		return mimeTypeTag?.[1] ?? 'image/jpeg';
	}

	/**
	 * Send NIP-04 encrypted DM to buyer with decryption key
	 * Fire-and-forget (doesn't await)
	 */
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
			event.kind = 4;  // NIP-04 encrypted DM
			event.content = encrypted;
			event.tags = [['p', buyerPubkey]];

			await event.publish();
		} catch (err) {
			// Silently fail — DM delivery is best-effort
			console.warn('[ZapImageSDK] Failed to send DM to buyer:', err);
		}
	}

	/**
	 * Create an encrypted image listing event (for upload)
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
		event.kind = 30024;  // KIND_IMAGE_LISTING
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
}
