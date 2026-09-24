import pypdf

def extract_pdf_text(pdf_path, output_path):
    print(f"Reading {pdf_path}...")
    reader = pypdf.PdfReader(pdf_path)
    total_pages = len(reader.pages)
    print(f"Total pages: {total_pages}")
    
    with open(output_path, "w", encoding="utf-8") as f:
        for idx, page in enumerate(reader.pages):
            f.write(f"\n--- PAGE {idx + 1} ---\n")
            text = page.extract_text()
            f.write(text)
            print(f"Extracted page {idx + 1}/{total_pages}")
            
    print(f"Saved all text to {output_path}")

if __name__ == "__main__":
    extract_pdf_text("STELCERA.pdf", "STELCERA_masterplan_text.txt")
