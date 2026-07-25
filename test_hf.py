import urllib.error
import urllib.request
try:
    req = urllib.request.Request("https://huggingface.co/api/models/black-forest-labs/FLUX.1-dev")
    resp = urllib.request.urlopen(req)
except Exception as e:
    print(type(e), e)
