@echo off
echo ============================================
echo  Two-Stage Fine-tuning Pipeline
echo  Stage 1: SFT (QLoRA + CE Loss)
echo  Stage 2: DPO (Preference Optimization)
echo  Target: RTX 3060 Laptop 6GB VRAM
echo ============================================

echo.
echo [1/7] Installing dependencies...
pip install -r requirements_finetune.txt
if %errorlevel% neq 0 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo [2/7] Checking GPU...
python -c "import torch; print(f'CUDA available: {torch.cuda.is_available()}'); print(f'GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}'); print(f'VRAM: {torch.cuda.get_device_properties(0).total_mem / 1024**3:.1f} GB' if torch.cuda.is_available() else 'N/A')"
if %errorlevel% neq 0 (
    echo ERROR: GPU check failed
    pause
    exit /b 1
)

echo.
echo [3/7] Checking base model...
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
echo ============================================
echo  Stage 1: SFT (Supervised Fine-Tuning)
echo  Loss: Cross-Entropy (Causal LM)
echo  Purpose: Learn basic format and knowledge
echo ============================================
echo.
echo [4/7] Generating training data...
python generate_train_set.py
python generate_test_set.py
python verify_sets.py

echo.
echo [5/7] Starting SFT training...
python finetune_qlora.py
if %errorlevel% neq 0 (
    echo ERROR: SFT training failed
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Stage 2: DPO (Direct Preference Optimization)
echo  Loss: DPO Loss (preference-based)
echo  Purpose: Learn to distinguish good vs bad answers
echo ============================================
echo.
echo [6/7] Generating DPO preference data and training...
echo This uses GLM-4.5-air API to score candidate answers.
echo Make sure GLM_API_KEY is set if not using default.
echo.
python generate_dpo_data.py
if %errorlevel% neq 0 (
    echo ERROR: DPO data generation failed
    echo You can skip DPO and use SFT model directly.
    pause
    exit /b 1
)

python finetune_dpo.py
if %errorlevel% neq 0 (
    echo ERROR: DPO training failed
    echo You can use SFT model (output/final) directly.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Merging LoRA weights into base model
echo  Output: ./merged_model
echo ============================================
echo.
echo [7/7] Merging DPO model into base model...
python merge_lora.py --lora_path output_dpo/final
if %errorlevel% neq 0 (
    echo WARNING: Merge failed, trying SFT model...
    python merge_lora.py --lora_path output/final
    if %errorlevel% neq 0 (
        echo ERROR: Merge failed. You can use LoRA directly:
        echo   python serve.py --lora output_dpo/final
        pause
        exit /b 1
    )
)

echo.
echo ============================================
echo  All Done!
echo  Merged model: ./merged_model
echo ============================================
echo.
echo To deploy:
echo   python serve.py
echo.
echo To use LoRA directly (no merge):
echo   python serve.py --lora output_dpo/final
echo.
pause
