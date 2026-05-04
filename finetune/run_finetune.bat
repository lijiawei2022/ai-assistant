@echo off
echo ============================================
echo  QLoRA Fine-tuning Setup - Qwen2.5-Coder-3B
echo  Target: RTX 3060 Laptop 6GB VRAM
echo ============================================

echo.
echo [1/4] Installing dependencies...
pip install -r requirements_finetune.txt
if %errorlevel% neq 0 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo [2/4] Checking GPU...
python -c "import torch; print(f'CUDA available: {torch.cuda.is_available()}'); print(f'GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}'); print(f'VRAM: {torch.cuda.get_device_properties(0).total_mem / 1024**3:.1f} GB' if torch.cuda.is_available() else 'N/A')"
if %errorlevel% neq 0 (
    echo ERROR: GPU check failed
    pause
    exit /b 1
)

echo.
echo [3/4] Checking base model...
if not exist "base_model" (
    echo Base model not found. Downloading...
    echo This will download ~6GB of model weights from hf-mirror.com
    python download_model.py
    if %errorlevel% neq 0 (
        echo ERROR: Model download failed
        pause
        exit /b 1
    )
) else (
    echo Base model found at ./base_model
)

echo.
echo [4/4] Starting fine-tuning...
python finetune_qlora.py
if %errorlevel% neq 0 (
    echo ERROR: Training failed
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Training complete!
echo  Output: ./output/final
echo ============================================
echo.
echo Next steps:
echo   1. Test:  python test_inference.py
echo   2. Merge: python merge_lora.py
echo   3. Import to Ollama: see merge_lora.py output
echo.
pause
