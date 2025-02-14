import { 
    Connection, 
    PublicKey, 
    Keypair, 
    Transaction,
    ComputeBudgetProgram
} from '@solana/web3.js';
import { 
    getAssociatedTokenAddress, 
    createAssociatedTokenAccountInstruction, 
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import bs58 from 'bs58';
import * as fs from 'fs';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize connection
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const connection = new Connection(RPC_URL, 'confirmed');

// Initialize keypair from environment variable
if (!process.env.WALLET_PRIVATE_KEY) {
    throw new Error('WALLET_PRIVATE_KEY is not set in environment variables');
}
const privateKeyDecoded = bs58.decode(process.env.WALLET_PRIVATE_KEY);
const keypair = Keypair.fromSecretKey(privateKeyDecoded);

// Load pools data
const pools = JSON.parse(fs.readFileSync('pools.json', 'utf8'));

// Utility function for retrying operations
async function withRetry(operation, description = '', maxRetries = 5, initialBackoff = 500) {
    let retryCount = 0;
    let backoff = initialBackoff;

    while (true) {
        try {
            return await operation();
        } catch (error) {
            retryCount++;
            
            if (error.message && (
                error.message.includes('429') ||
                error.message.includes('failed to get accounts') ||
                error.message.includes('failed to send transaction') ||
                error.message.includes('block height exceeded') ||
                error.message.includes('blockhash not found') ||
                error.message.includes('Network Error')
            )) {
                if (retryCount > maxRetries) {
                    throw new Error(`Max retries (${maxRetries}) exceeded for ${description}: ${error.message}`);
                }
                console.log(`Retrying ${description} (${retryCount}/${maxRetries}) in ${backoff}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoff));
                backoff *= 2;
                continue;
            }
            
            throw error;
        }
    }
}

async function createTokenAccount(tokenMint) {
    console.log(`\nCreating token account for mint: ${tokenMint}`);
    
    try {
        const mintPubkey = new PublicKey(tokenMint);
        
        // Get ATA address
        const userTokenAta = await getAssociatedTokenAddress(
            mintPubkey,
            keypair.publicKey,
            false,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        // Check if account already exists
        const tokenAccount = await withRetry(
            () => connection.getAccountInfo(userTokenAta),
            'get token account info'
        );

        if (tokenAccount) {
            console.log('Token account already exists:', userTokenAta.toString());
            return null;
        }

        // Create new transaction
        const transaction = new Transaction();

        // Set fixed priority fee
        const priorityFee = 750000; // 0.75 lamports per compute unit

        // Add compute budget instructions
        transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({
                units: 200000
            })
        );

        transaction.add(
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: priorityFee
            })
        );

        // Add create account instruction
        transaction.add(
            createAssociatedTokenAccountInstruction(
                keypair.publicKey,
                userTokenAta,
                keypair.publicKey,
                mintPubkey,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            )
        );

        // Get latest blockhash
        const latestBlockhash = await withRetry(
            () => connection.getLatestBlockhash('confirmed'),
            'get latest blockhash'
        );

        transaction.feePayer = keypair.publicKey;
        transaction.recentBlockhash = latestBlockhash.blockhash;
        transaction.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
        
        // Sign and send transaction
        transaction.sign(keypair);
        
        const signature = await withRetry(
            () => connection.sendRawTransaction(transaction.serialize(), {
                skipPreflight: true
            }),
            'send transaction'
        );

        // Confirm transaction
        const confirmation = await withRetry(
            () => connection.confirmTransaction({
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            }),
            'confirm transaction'
        );

        if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        console.log('Token account created successfully!');
        console.log('Transaction signature:', signature);
        console.log('Token ATA:', userTokenAta.toString());
        console.log(`View on Explorer: https://solscan.io/tx/${signature}`);
        
        return signature;

    } catch (error) {
        console.error('Error creating token account:', error);
        throw error;
    }
}

async function main() {
    console.log('Starting token account creation for all pools...');
    console.log(`Total pools to process: ${pools.length}`);
    
    for (let i = 0; i < pools.length; i++) {
        const pool = pools[i];
        console.log(`\nProcessing pool ${i + 1}/${pools.length}`);
        
        try {
            await createTokenAccount(pool.mint);
        } catch (error) {
            console.error(`Failed to create token account for mint ${pool.mint}:`, error);
            // Continue with next pool even if one fails
        }
    }
    
    console.log('\nAll pools processed!');
    process.exit(0);
}

// Start the script
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
