import os

def get_model_subfolders(models_dir: str = None) -> list:
    if models_dir is None:
        models_dir = os.path.join(os.getcwd(), "models")
    if not os.path.exists(models_dir):
        return []
    subfolders = [name for name in os.listdir(models_dir)
                  if os.path.isdir(os.path.join(models_dir, name))]
    subfolders.sort()
    priority = ["checkpoints", "clip", "diffusion_models", "vae", "loras", "controlnet"]
    prio_list = [p for p in priority if p in subfolders]
    non_prio = [f for f in subfolders if f not in priority]
    return prio_list + non_prio
