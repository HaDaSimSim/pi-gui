// pi-gui 데스크톱 진입점.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pi_gui_lib::run()
}
