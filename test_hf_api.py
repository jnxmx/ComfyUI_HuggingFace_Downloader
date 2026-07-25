from huggingface_hub import HfApi
try:
    api = HfApi()
    info = api.model_info("black-forest-labs/FLUX.1-dev", files_metadata=True)
except Exception as e:
    print(type(e), e)
