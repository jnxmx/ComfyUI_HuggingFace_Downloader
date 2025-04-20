import sys
import os
from dotenv import load_dotenv, set_key, unset_key

env_file_path = os.path.join(os.getcwd(), ".env")

def update_token(token_value):
    """
    Update or remove the HF_TOKEN_FOR_HFD entry in the .env file.
    """
    load_dotenv(env_file_path)
    if token_value:
        set_key(env_file_path, "HF_TOKEN_FOR_HFD", token_value)
        print("HF_TOKEN_FOR_HFD updated in .env file.")
    else:
        unset_key(env_file_path, "HF_TOKEN_FOR_HFD")
        print("HF_TOKEN_FOR_HFD removed from .env file.")

if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] != "update":
        print("Usage: python3 -m tokenhandling update <token_value>")
        sys.exit(1)
    token_value = sys.argv[2] if len(sys.argv) > 2 else ""
    update_token(token_value)
