/**
 * sni.js — Parse the SNI hostname from a TLS ClientHello record.
 *
 * The relay is blind: it never terminates TLS. It only peeks at the
 * unencrypted ClientHello (which is always in the clear) to learn which
 * slug/device to forward the connection to.
 *
 * parseSNI() keeps the legacy public contract: hostname string or null.
 * parseSNIResult() exposes the reason so the router can distinguish a split
 * ClientHello from a malformed one.
 */

export function parseSNI(buffer) {
  const result = parseSNIResult(buffer);
  return result.ok ? result.hostname : null;
}

export function parseSNIResult(buffer) {
  try {
    // Minimum viable ClientHello is ~43 bytes before variable fields.
    if (!Buffer.isBuffer(buffer)) return { ok: false, reason: 'invalid_buffer' };
    if (buffer.length < 5) return { ok: false, reason: 'incomplete' };

    // Record layer
    const recordType = buffer[0];
    if (recordType !== 0x16) return { ok: false, reason: 'not_handshake_record' };

    // Bytes 1-2: TLS version — accept any (0x0301 .. 0x0304)
    const tlsMajor = buffer[1];
    if (tlsMajor !== 0x03) return { ok: false, reason: 'invalid_tls_version' };

    const recordLength = buffer.readUInt16BE(3);
    const recordEnd = 5 + recordLength;
    if (buffer.length < recordEnd) return { ok: false, reason: 'incomplete' };

    // Handshake layer starts at byte 5
    const handshakeType = buffer[5];
    if (handshakeType !== 0x01) return { ok: false, reason: 'not_client_hello' };

    // Bytes 6-8: handshake length (uint24 big-endian)
    const handshakeLength =
      (buffer[6] << 16) | (buffer[7] << 8) | buffer[8];
    const handshakeEnd = 9 + handshakeLength;
    if (handshakeEnd > recordEnd) return { ok: false, reason: 'invalid_handshake_length' };

    // Work within the handshake body (offset 9 from start of record)
    let offset = 9;

    // Client version (2 bytes)
    offset += 2;

    // Random (32 bytes)
    offset += 32;

    if (offset >= handshakeEnd) return { ok: false, reason: 'malformed_client_hello' };

    // Session ID
    const sessionIdLength = buffer[offset];
    offset += 1 + sessionIdLength;

    if (offset + 2 > handshakeEnd) return { ok: false, reason: 'malformed_client_hello' };

    // Cipher suites
    const cipherSuitesLength = buffer.readUInt16BE(offset);
    offset += 2 + cipherSuitesLength;

    if (offset + 1 > handshakeEnd) return { ok: false, reason: 'malformed_client_hello' };

    // Compression methods
    const compressionMethodsLength = buffer[offset];
    offset += 1 + compressionMethodsLength;

    // Extensions — may be absent for very old clients (we skip gracefully)
    if (offset + 2 > handshakeEnd) return { ok: false, reason: 'missing_sni' };

    const extensionsLength = buffer.readUInt16BE(offset);
    offset += 2;

    const extensionsEnd = offset + extensionsLength;
    if (extensionsEnd > handshakeEnd) return { ok: false, reason: 'malformed_extensions' };

    // Walk extensions looking for type 0x0000 (server_name)
    while (offset + 4 <= extensionsEnd) {
      const extType = buffer.readUInt16BE(offset);
      const extLength = buffer.readUInt16BE(offset + 2);
      offset += 4;

      if (extType === 0x0000) {
        // SNI extension
        // server_name_list_length (2 bytes)
        if (offset + 2 > extensionsEnd) return { ok: false, reason: 'malformed_sni' };
        const listLength = buffer.readUInt16BE(offset);
        let listOffset = offset + 2;
        const listEnd = listOffset + listLength;
        if (listEnd > extensionsEnd) return { ok: false, reason: 'malformed_sni' };

        while (listOffset + 3 <= listEnd) {
          const nameType = buffer[listOffset];
          const nameLength = buffer.readUInt16BE(listOffset + 1);
          listOffset += 3;

          if (nameType === 0x00) {
            // host_name
            if (listOffset + nameLength > listEnd) return { ok: false, reason: 'malformed_sni' };
            return {
              ok: true,
              hostname: buffer.toString('ascii', listOffset, listOffset + nameLength),
            };
          }
          listOffset += nameLength;
        }
        return { ok: false, reason: 'missing_sni' }; // SNI ext found but no hostname entry
      }

      offset += extLength;
      if (offset > extensionsEnd) return { ok: false, reason: 'malformed_extensions' };
    }

    return { ok: false, reason: 'missing_sni' }; // no SNI extension present
  } catch {
    return { ok: false, reason: 'malformed_client_hello' };
  }
}
