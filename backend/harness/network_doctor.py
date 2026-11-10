"""Read-only OS DNS diagnostics for the actual Python runtime."""
import os
import socket
import sys
from concurrent.futures import ThreadPoolExecutor


def main():
    print('Python:', sys.version.split()[0])
    print('Proxy environment flags (values hidden):', ', '.join(key for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY') if os.environ.get(key) or os.environ.get(key.lower())) or 'none')
    def lookup(host):
        try: return host, f'OK ({len({row[4][0] for row in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})} addresses)'
        except OSError as error: return host, f'FAILED ({error.__class__.__name__})'
    with ThreadPoolExecutor(max_workers=3) as executor:
        for host, result in executor.map(lookup, ('playwright.dev', 'api.openai.com', 'pypi.org')):
            print(f'{host:24} OS lookup {result}')
    print('No DNS settings were changed and no fallback was enabled.')


if __name__ == '__main__': main()
