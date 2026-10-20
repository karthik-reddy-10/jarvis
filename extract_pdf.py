import sys
import json
import pypdf

# Ensure standard output handles UTF-8 mathematical and unicode characters
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def extract_pdf_intel(file_path):
    try:
        reader = pypdf.PdfReader(file_path)
        total_pages = len(reader.pages)
        extracted_sections = []
        
        # If massive textbook (> 60 pages), extract first 35 pages (preface, TOC, syllabus breakdown)
        pages_to_read = range(min(total_pages, 35)) if total_pages > 60 else range(total_pages)
        
        total_chars = 0
        for i in pages_to_read:
            page = reader.pages[i]
            text = page.extract_text() or ''
            if text.strip():
                extracted_sections.append(f"--- [PAGE {i+1}] ---\n{text.strip()}")
                total_chars += len(text)
            if total_chars > 30000:
                break
                
        full_text = "\n\n".join(extracted_sections)
        
        # Check if scanned (zero text extracted)
        has_images = False
        if not full_text.strip() and total_pages > 0:
            for p in reader.pages[:3]:
                if len(p.images) > 0:
                    has_images = True
                    break
                    
        return {
            "success": True,
            "totalPages": total_pages,
            "text": full_text,
            "isScanned": has_images and not full_text.strip()
        }
    except Exception as e:
        return {
            "success": False,
            "totalPages": 0,
            "text": "",
            "error": str(e)
        }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No file path provided"}))
        sys.exit(1)
        
    path = sys.argv[1]
    res = extract_pdf_intel(path)
    print(json.dumps(res, ensure_ascii=False))
