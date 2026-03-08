"use node";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function deriveUserKey(
	masterKeyBase64: string,
	userId: string
): Promise<CryptoKey> {
	const masterKeyBytes = Uint8Array.from(atob(masterKeyBase64), (c) =>
		c.charCodeAt(0)
	);

	const hkdfKey = await crypto.subtle.importKey(
		"raw",
		masterKeyBytes,
		"HKDF",
		false,
		["deriveKey"]
	);

	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(32),
			info: encoder.encode(userId),
		},
		hkdfKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"]
	);
}

export async function encrypt(
	key: CryptoKey,
	plaintext: string
): Promise<{ ciphertext: string; iv: string }> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertextBuffer = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		encoder.encode(plaintext)
	);

	return {
		ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertextBuffer))),
		iv: btoa(String.fromCharCode(...iv)),
	};
}

export async function decrypt(
	key: CryptoKey,
	ciphertext: string,
	iv: string
): Promise<string> {
	const ciphertextBytes = Uint8Array.from(atob(ciphertext), (c) =>
		c.charCodeAt(0)
	);
	const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));

	const plaintextBuffer = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: ivBytes },
		key,
		ciphertextBytes
	);

	return decoder.decode(plaintextBuffer);
}
