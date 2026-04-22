#!/usr/bin/env python3
"""Manual smoke test for Amazon.it product scraping.

Usage:
    python writer/test_amazon_scrape.py B0DK2TLB6P
    python writer/test_amazon_scrape.py --url https://www.amazon.it/dp/B0DK2TLB6P

Optional dependencies:
    pip install requests beautifulsoup4
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup


DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,*/*;q=0.8"
    ),
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

PRICE_SELECTORS = (
    "#corePriceDisplay_desktop_feature_div .apexPriceToPay .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .reinventPricePriceToPayMargin .a-offscreen",
    "#corePrice_feature_div .apexPriceToPay .a-offscreen",
    "#corePrice_feature_div .a-price .a-offscreen",
    "#priceblock_ourprice",
    "#priceblock_dealprice",
    "#priceblock_saleprice",
    ".apexPriceToPay .a-offscreen",
    ".reinventPricePriceToPayMargin .a-offscreen",
    ".a-price.aok-align-center .a-offscreen",
    ".a-price .a-offscreen",
)

PRICE_RE = re.compile(r"(?:€\s*)?\d{1,3}(?:\.\d{3})*(?:,\d{2})?(?:\s*€)?")
ASIN_RE = re.compile(r"/dp/([A-Z0-9]{10})(?:[/?]|$)", re.IGNORECASE)


@dataclass(slots=True)
class ScrapeResult:
    asin: str
    url: str
    status_code: int
    title: str | None
    price: str | None
    price_selector: str | None
    candidates: list[tuple[str, str]]
    captcha: bool


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Smoke-test scraping of an Amazon.it product page."
    )
    parser.add_argument("asin", nargs="?", help="Amazon ASIN, e.g. B0DK2TLB6P")
    parser.add_argument("--url", help="Full Amazon product URL")
    parser.add_argument(
        "--timeout",
        type=float,
        default=15.0,
        help="HTTP timeout in seconds (default: 15)",
    )
    parser.add_argument(
        "--dump-html",
        action="store_true",
        help="Print the first 2000 chars of the HTML response for debugging",
    )
    return parser.parse_args()


def extract_asin_from_url(url: str) -> str | None:
    match = ASIN_RE.search(url)
    return match.group(1).upper() if match else None


def build_target(asin: str | None, url: str | None) -> tuple[str, str]:
    if url:
        parsed = urlparse(url)
        if parsed.netloc and "amazon." not in parsed.netloc:
            raise ValueError(f"Unsupported host: {parsed.netloc}")
        extracted = extract_asin_from_url(url)
        if not extracted:
            raise ValueError("Could not extract ASIN from URL")
        return extracted, url

    if not asin:
        raise ValueError("Provide either an ASIN or --url")

    normalized = asin.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{10}", normalized):
        raise ValueError(f"Invalid ASIN: {asin!r}")
    return normalized, f"https://www.amazon.it/dp/{normalized}"


def collect_price_candidates(soup: BeautifulSoup) -> list[tuple[str, str]]:
    seen: list[tuple[str, str]] = []
    seen_set: set[tuple[str, str]] = set()

    for selector in PRICE_SELECTORS:
        for node in soup.select(selector):
            text = " ".join(node.stripped_strings)
            item = (selector, text)
            if text and item not in seen_set and PRICE_RE.search(text):
                seen.append(item)
                seen_set.add(item)

    return seen


def resolve_price(candidates: Iterable[tuple[str, str]]) -> tuple[str | None, str | None]:
    for selector, candidate in candidates:
        match = PRICE_RE.search(candidate)
        if match:
            return match.group(0).strip(), selector
    return None, None


def fetch_html(url: str, timeout: float) -> str:
    response = requests.get(url, headers=DEFAULT_HEADERS, timeout=timeout)
    response.raise_for_status()
    return response.text


def print_result(result: ScrapeResult, dump_html: bool, html: str | None) -> None:
    print(f"ASIN:     {result.asin}")
    print(f"URL:      {result.url}")
    print(f"HTTP:     {result.status_code}")
    print(f"CAPTCHA:  {'yes' if result.captcha else 'no'}")
    print(f"Title:    {result.title or 'N/A'}")
    print(f"Price:    {result.price or 'N/A'}")
    print(f"Selector: {result.price_selector or 'N/A'}")
    print("Candidates:")
    if result.candidates:
        for selector, candidate in result.candidates[:10]:
            print(f"  - {selector}: {candidate}")
    else:
        print("  - none")

    if dump_html and html is not None:
        print("\nHTML preview:")
        print(html[:2000])


def main() -> int:
    args = parse_args()

    try:
        asin, url = build_target(args.asin, args.url)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    html: str | None = None
    try:
        html = fetch_html(url, args.timeout)
        soup = BeautifulSoup(html, "html.parser")
        title_node = soup.select_one("#productTitle")
        candidates = collect_price_candidates(soup)
        resolved_price, resolved_selector = resolve_price(candidates)
        body = html.lower()
        result = ScrapeResult(
            asin=asin,
            url=url,
            status_code=200,
            title=title_node.get_text(strip=True) if title_node else None,
            price=resolved_price,
            price_selector=resolved_selector,
            candidates=candidates,
            captcha="captcha" in body or ("benvenuto" in body and "digita i caratteri" in body),
        )
    except requests.RequestException as exc:
        print(f"request failed: {exc}", file=sys.stderr)
        return 1

    print_result(result, args.dump_html, html if args.dump_html else None)

    if result.captcha:
        return 3
    if result.price is None:
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
