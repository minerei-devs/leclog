fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }

    tauri_build::build()
}
