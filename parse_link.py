from urllib.parse import urlparse, parse_qs

def parse_link(link: str) -> dict:
    """
    Parse a Hugging Face URL or shorthand string.
    Supports URLs with keywords "resolve", "blob", or "tree".
    Returns a dictionary with keys:
      - repo: e.g., "username/repo"
      - revision: if present (e.g., "main")
      - subfolder: if present (the path inside the repo)
      - file: if present (the file name for file downloads)
    """
    parsed_url = urlparse(link)
    if parsed_url.scheme:
        path_parts = parsed_url.path.strip("/").split("/")
    else:
        path_parts = link.strip("/").split("/")

    result = {}
    if len(path_parts) >= 2:
        result["repo"] = f"{path_parts[0]}/{path_parts[1]}"
    else:
        raise ValueError("Link does not contain repository information.")

    if "resolve" in path_parts:
        idx = path_parts.index("resolve")
        if len(path_parts) > idx + 1:
            result["revision"] = path_parts[idx+1]
        if len(path_parts) > idx + 2:
            remaining = path_parts[idx+2:]
            if remaining:
                if len(remaining) > 1:
                    result["subfolder"] = "/".join(remaining[:-1])
                result["file"] = remaining[-1]
    elif "blob" in path_parts:
        idx = path_parts.index("blob")
        if len(path_parts) > idx + 1:
            result["revision"] = path_parts[idx+1]
        if len(path_parts) > idx + 2:
            remaining = path_parts[idx+2:]
            if remaining:
                if len(remaining) > 1:
                    result["subfolder"] = "/".join(remaining[:-1])
                result["file"] = remaining[-1]
    elif "tree" in path_parts:
        idx = path_parts.index("tree")
        if len(path_parts) > idx + 1:
            result["revision"] = path_parts[idx+1]
        if len(path_parts) > idx + 2:
            result["subfolder"] = "/".join(path_parts[idx+2:])
    else:
        if len(path_parts) > 2:
            if "." in path_parts[-1]:
                result["subfolder"] = "/".join(path_parts[2:-1])
                result["file"] = path_parts[-1]
            else:
                result["subfolder"] = "/".join(path_parts[2:])
    return result
