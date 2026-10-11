fn main() {
    // Force la recompilation quand les icônes changent : tauri_build embarque
    // l'icône dans le binaire, mais ne recompile pas toujours si seule l'image change.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build();
}
