import os
import re
import yaml
from typing import Any

ENV_PATTERN = re.compile(r"\$\{([^:-]+)(?::-([^}]*))?\}")

def resolve_env_strings(data: Any) -> Any:
    if isinstance(data, dict):
        return {k: resolve_env_strings(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [resolve_env_strings(i) for i in data]
    elif isinstance(data, str):
        def replace_match(m):
            var_name = m.group(1)
            default_val = m.group(2) if m.group(2) is not None else ""
            return os.environ.get(var_name, default_val)
        return ENV_PATTERN.sub(replace_match, data)
    return data

def load_yaml_with_env(file_path: str) -> Any:
    with open(file_path, "r", encoding="utf-8") as f:
        raw_data = yaml.safe_load(f)
    return resolve_env_strings(raw_data)
