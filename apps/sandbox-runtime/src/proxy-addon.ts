export const LOCAL_PROXY_ADDON_SCRIPT = `
import base64
import json
import os
import urllib.error
import urllib.request

from mitmproxy import http


WORKER_URL = os.environ.get("CORPORATION_PROXY_WORKER_URL", "").strip()
WORKER_TOKEN_PATH = os.environ.get("CORPORATION_PROXY_WORKER_TOKEN_PATH", "").strip()
WORKER_FORWARD_HOSTS = {
    host.strip().lower()
    for host in os.environ.get("CORPORATION_PROXY_WORKER_FORWARD_HOSTS", "").split(",")
    if host.strip()
}


def should_forward(flow: http.HTTPFlow) -> bool:
    if not WORKER_URL or not WORKER_FORWARD_HOSTS:
        return False
    return flow.request.host.lower() in WORKER_FORWARD_HOSTS


def build_forward_headers(flow: http.HTTPFlow) -> dict[str, str]:
    return {str(key): str(value) for key, value in flow.request.headers.items()}


def build_response_headers(headers) -> dict[str, str]:
    return {str(key): str(value) for key, value in headers.items()}


def get_worker_token() -> str:
    if not WORKER_TOKEN_PATH:
        return ""

    try:
        with open(WORKER_TOKEN_PATH, "r", encoding="utf-8") as token_file:
            return token_file.read().strip()
    except OSError:
        return ""


def build_worker_request(flow: http.HTTPFlow) -> urllib.request.Request:
    payload: dict[str, object] = {
        "url": flow.request.pretty_url,
        "method": flow.request.method,
        "headers": build_forward_headers(flow),
    }

    if flow.request.raw_content:
        payload["bodyBase64"] = base64.b64encode(flow.request.raw_content).decode("ascii")

    headers = {"content-type": "application/json"}
    worker_token = get_worker_token()
    if worker_token:
        headers["authorization"] = f"Bearer {worker_token}"

    return urllib.request.Request(
        WORKER_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )


class CorporationProxyAddon:
    def request(self, flow: http.HTTPFlow) -> None:
        if not should_forward(flow):
            return

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        try:
            with opener.open(build_worker_request(flow), timeout=30) as response:
                body = response.read()
                flow.response = http.Response.make(
                    response.status,
                    body,
                    build_response_headers(response.headers),
                )
        except urllib.error.HTTPError as error:
            flow.response = http.Response.make(
                error.code,
                error.read(),
                build_response_headers(error.headers),
            )
        except Exception as error:
            body = json.dumps(
                {"error": f"Worker proxy request failed: {error}"}
            ).encode("utf-8")
            flow.response = http.Response.make(
                502,
                body,
                {"content-type": "application/json"},
            )


addons = [CorporationProxyAddon()]
`;
