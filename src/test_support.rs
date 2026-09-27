use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

pub struct TempGame {
    pub dir: PathBuf,
}

impl TempGame {
    pub fn new(files: &[(&str, &str)]) -> TempGame {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "game-engine-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        for (name, contents) in files {
            let path = dir.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
        TempGame { dir }
    }

    pub fn path(&self, name: &str) -> String {
        self.dir.join(name).display().to_string()
    }
}

impl Drop for TempGame {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
