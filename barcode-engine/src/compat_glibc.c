/*
 * glibc symbol-version compatibility shim.
 *
 * Building against glibc >= 2.38 (Debian Trixie, Ubuntu 24.04+) makes
 * libstdc++ reference __isoc23_strtoul@GLIBC_2.38 — the C23 form of strtoul.
 * That symbol does not exist on hosts whose runtime libc is older than 2.38,
 * which breaks loading the addon on those systems. Defining the function
 * here as a thin wrapper over plain strtoul makes the linker satisfy the
 * reference locally, so the produced .node only needs GLIBC_2.2.5-era strtoul.
 */
#include <stdlib.h>

unsigned long __isoc23_strtoul(const char *nptr, char **endptr, int base) {
    return strtoul(nptr, endptr, base);
}
