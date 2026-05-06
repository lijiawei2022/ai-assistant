@echo off
echo ============================================
echo  Two-Stage Fine-tuning Pipeline
echo  Stage 1: SFT (QLoRA + CE Loss)
echo  Stage 2: DPO (Preference Optimization)
echo  Target: RTX 3060 Laptop 6GB VRAM
echo ============================================

echo.
echo [1/9] Installing dependencies...
pip install -r requirements_finetune.txt
if %errorlevel% neq 0 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo [2/9] Checking GPU...
python -c "import torch; print(f'CUDA available: {torch.cuda.is_available()}'); print(f'GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}'); print(f'VRAM: {torch.cuda.get_device_properties(0).total_mem / 1024**3:.1f} GB' if torch.cuda.is_available() else 'N/A')"
if %errorlevel% neq 0 (
    echo ERROR: GPU check failed
    pause
    exit /b 1
)

echo.
echo [3/9] Checking base model...
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
echo [4/9] Generating training data...
python generate_train_set.py
python generate_test_set.py
python verify_sets.py

echo.
echo [5/9] Starting SFT training...
python finetune_qlora.py
if %errorlevel% neq 0 (
    echo ERROR: SFT training failed
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Evaluating SFT Model
echo  Comparing Base vs SFT to verify improvement
echo ============================================
echo.
python evaluate_stages.py --stages base sft --max_samples 5
if %errorlevel% neq 0 (
    echo WARNING: SFT evaluation failed, continuing...
)

echo.
echo ============================================
echo  Stage 2: DPO (Direct Preference Optimization)
echo  Loss: DPO Loss (preference-based)
echo  Purpose: Learn to distinguish good vs bad answers
echo ============================================
echo.
echo [6/9] Generating DPO preference data and training...
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

echo.
echo [7/9] Starting DPO training...
python finetune_dpo.py
if %errorlevel% neq 0 (
    echo ERROR: DPO training failed
    echo You can use SFT model (output/final) directly.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Evaluating DPO Model
echo  Comparing Base vs SFT vs DPO
echo ============================================
echo.
python evaluate_stages.py --stages base sft dpo --max_samples 5
if %errorlevel% neq 0 (
    echo WARNING: DPO evaluation failed, continuing...
)

echo.
echo ============================================
echo  Merging LoRA weights - keeping 3 models
echo  1. base_model       (original, untouched)
echo  2. merged_model_sft  (base + SFT LoRA)
echo  3. merged_model_dpo  (base + DPO LoRA)
echo ============================================
echo.
echo [8/9] Merging SFT model...
python merge_lora.py --lora_path output/final --output_dir merged_model_sft
if %errorlevel% neq 0 (
    echo WARNING: SFT merge failed
)

echo.
echo Merging DPO model (base + SFT + DPO)...
python merge_lora.py --lora_path output_dpo/final --sft_lora_path output/final --output_dir merged_model_dpo
if %errorlevel% neq 0 (
    echo WARNING: DPO merge failed, trying SFT as fallback...
    python merge_lora.py --lora_path output/final --output_dir merged_model_dpo
    if %errorlevel% neq 0 (
        echo ERROR: Both merges failed. You can use LoRA directly:
        echo   python serve.py --lora output_dpo/final
        pause
        exit /b 1
    )
)

echo.
echo ============================================
echo  Plotting Training Loss Curves
echo ============================================
echo.
echo [9/9] Generating training loss plots...
python plot_training.py
if %errorlevel% neq 0 (
    echo WARNING: Plot generation failed, skipping...
)

echo.
echo ============================================
echo  All Done!
echo  Three models available:
echo ============================================
echo.
echo  1. base_model/         - Original Qwen2.5-Coder-3B-Instruct
echo  2. merged_model_sft/   - Base + SFT LoRA (format + knowledge)
echo  3. merged_model_dpo/   - Base + SFT + DPO LoRA (preference optimized)
echo.
echo  Evaluation results:
echo    - evaluation_stages_results.json  (Base vs SFT vs DPO comparison)
echo.
echo  To deploy (choose one):
echo    python serve.py                                    # Base model
echo    python serve.py --lora output/final                # SFT LoRA
echo    python serve.py --lora output_dpo/final            # DPO LoRA
echo.
echo  To use merged models directly:
echo    python serve.py --base_model merged_model_sft      # SFT merged
echo    python serve.py --base_model merged_model_dpo      # DPO merged
echo.
echo  To run full evaluation (all test samples):
echo    python evaluate_stages.py --stages base sft dpo
echo.
pause
