#[test]
fn svm_starts() {
    let svm = litesvm::LiteSVM::new();
    let _ = svm.latest_blockhash();
}
