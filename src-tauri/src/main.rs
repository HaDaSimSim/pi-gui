// pi-gui desktop entry point.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pi_gui_lib::run()
}
