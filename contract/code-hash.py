"""Prints a wasm file's sha256 and NEAR code hash (base58 of the sha256), as `near state` shows it."""
import hashlib
import sys

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + out


digest = hashlib.sha256(open(sys.argv[1], "rb").read()).digest()
print(f"sha256 {digest.hex()}")
print(f"code_hash {base58(digest)}")
